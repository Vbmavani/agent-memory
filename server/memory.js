// Long-term memory about the user, stored on the users row:
//   users.facts       semantic memory   WHAT is true about the user   {id, text}
//   users.procedures  procedural memory HOW the user wants you to work {id, when, do}
//
// ONE WRITER. Every message gets exactly one memory decision, made by one model call that sees
// everything at once: the existing facts and procedures, the previous reply, the user's message,
// and any explicit requests the chat model recorded via its memory tools. The chat model's tools
// never write directly; they only record requests. That is what stops two writers from creating
// overlapping entries (e.g. one adding "User is in France" while the other updates "User lives in Lyon").
//
// Flow per message:
//   1. In parallel with the reply, decide speculatively from the message alone (no extra wait).
//   2. If the chat model recorded explicit requests, decide again WITH them (one decision wins).
//   3. Validate the operations, then apply them in one transaction (db.applyMemoryOps -> mergeItems),
//      which also rejects stale writes and near-duplicates.
import { randomUUID } from 'node:crypto'
import { deepseek } from './deepseek.js'

export const MEMORY_MODEL = 'deepseek-flash'
export const MAX_FACTS = 100
export const MAX_PROCEDURES = 30
const MAX_OPS = 20

// "User's favourite drink is Chai!" and "user favourite drink is chai" compare equal.
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/^user('s)?\s+/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const newId = () => randomUUID().replace(/-/g, '').slice(0, 10)
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

// The two kinds of memory share the same validation and merge logic.
//   fields: stored text fields and their max length
//   key:    identity for de-duplication (facts: the whole sentence; procedures: the trigger,
//           so there is one procedure per situation)
//   label:  one-line text, used as the stale-write snapshot and in the change history
export const KINDS = {
  fact: {
    fields: { text: 200 },
    max: MAX_FACTS,
    key: (x) => normalize(x.text),
    label: (x) => x.text,
    mergeDuplicateUpdate: true, // an update that becomes another fact's text merges the two
  },
  procedure: {
    fields: { when: 150, do: 800 },
    max: MAX_PROCEDURES,
    key: (x) => normalize(x.when),
    label: (x) => `When ${x.when}: ${x.do}`,
    mergeDuplicateUpdate: false, // never throw away instructions; skip instead
  },
}
const pick = (spec, x) => Object.fromEntries(Object.keys(spec.fields).map((f) => [f, x[f]]))

export const MEMORY_PROMPT = `You maintain the long-term memory of an assistant. It has two parts:

FACTS: short facts about WHO the USER is that will still matter in future conversations (where they live,
work, family, pets, health/allergies, diet, goals, plans, strong likes and dislikes, recurring situations).

PROCEDURES: HOW the user wants the assistant to WORK: a trigger ("when") and instructions ("do").
  - Routines the user teaches: "when I say 'standup', ask me ... then ...".
  - Standing rules: "from now on ...", "always ...", "never ...", "next time ...".
  - Corrections of HOW the previous reply was done that the user means for the future
    ("too long, for tech stuff give me 3 bullets"). Use the PREVIOUS REPLY to understand what to change.
  - Lessons the assistant itself recorded (explicit requests with action "learn_procedure").
  Format, length, tone, language, units and workflow preferences are PROCEDURES, never facts.

You get EXISTING FACTS and EXISTING PROCEDURES (with ids), the user's PROFILE, the assistant's PREVIOUS reply
(context only), the user's NEW message, and sometimes EXPLICIT REQUESTS recorded by the assistant.
Return json: {"facts": [...], "procedures": [...]} with ops:
  facts:      {"op":"add","text":"<fact>"} | {"op":"update","id":"<id>","text":"<new full fact>"} | {"op":"delete","id":"<id>"}
  procedures: {"op":"add","when":"<trigger>","do":"<instructions>"} | {"op":"update","id":"<id>","when":"...","do":"..."} | {"op":"delete","id":"<id>"}

Rules:
1. ONE FACT PER ATTRIBUTE (home city/country, job, each pet, each preference, each allergy...).
   If the new information is about an attribute an existing fact already covers, UPDATE that fact,
   combining both when they are compatible ("lives in Lyon" + "in France" -> "lives in Lyon, France"),
   or do nothing if it is already implied. Never add a second fact about the same attribute.
2. ONE PROCEDURE PER SITUATION. If an existing procedure's trigger covers the situation, UPDATE it and
   write the COMPLETE merged instructions (keep the old steps the user did not change).
3. Only what the USER states or clearly asks for, never from the assistant's words alone.
4. Questions, greetings, small talk, one-off moods, the weather, requests for help, a one-off tweak of
   just this answer ("make that shorter", "translate it") and the user's answers WHILE a routine is running
   (e.g. what they did yesterday during a standup) -> nothing.
5. Do not repeat the PROFILE. If the user says something is no longer true or wanted, DELETE (or UPDATE) it.
6. EXPLICIT REQUESTS must all be honored, but still follow rules 1 and 2: "remember X" where an existing
   fact covers X becomes an UPDATE of that fact (or nothing if exactly covered); "forget X" becomes DELETE
   of every matching fact or procedure. Also handle anything else in the NEW message.
7. A fact is one short third-person sentence starting with "User".
   A procedure's "when" is a short situation the assistant can recognise ("the user says 'standup'",
   "explaining a technical concept", "searching past chats"); "do" is concrete imperative instructions
   to the assistant, with every step in order. Make it general enough to reuse, but no broader than
   the user meant. When in doubt, do nothing.

Examples:
NEW: "what's the capital of France?" -> {"facts": [], "procedures": []}
FACTS: [{"id":"a1","text":"User lives in Pune"}] | NEW: "I just moved to Berlin and started at Zalando"
  -> {"facts": [{"op":"update","id":"a1","text":"User lives in Berlin"},{"op":"add","text":"User works at Zalando"}], "procedures": []}
FACTS: [{"id":"c3","text":"User lives in Lyon"}] | NEW: "remember that I'm in France"
  | REQUESTS: [{"action":"remember","text":"User is in France"}]
  -> {"facts": [{"op":"update","id":"c3","text":"User lives in Lyon, France"}], "procedures": []}
FACTS: [{"id":"d4","text":"User's favourite drink is chai"},{"id":"e5","text":"User goes hiking every weekend"}]
  | NEW: "forget my favourite drink and that I hike" | REQUESTS: [{"action":"forget","id":"d4"}]
  -> {"facts": [{"op":"delete","id":"d4"},{"op":"delete","id":"e5"}], "procedures": []}
NEW: "When I say 'weekly', list my open tasks by priority, then ask which one to start"
  -> {"facts": [], "procedures": [{"op":"add","when":"the user says 'weekly'","do":"List the user's open tasks grouped by priority, then ask which one they want to start."}]}
PREVIOUS REPLY: a long multi-section explanation of DNS | NEW: "way too long. for tech explanations just give me 3 bullets and an example"
  -> {"facts": [], "procedures": [{"op":"add","when":"explaining a technical concept","do":"Answer in at most 3 short bullet points, then give one concrete example. No headings or long intros."}]}
PROCEDURES: [{"id":"p1","when":"the user says 'weekly'","do":"List open tasks by priority, then ask which to start."}]
  | NEW: "for weekly, also show what I finished last week first"
  -> {"facts": [], "procedures": [{"op":"update","id":"p1","when":"the user says 'weekly'","do":"First show what the user finished last week, then list open tasks by priority, then ask which to start."}]}
PREVIOUS REPLY: "Got it. What did you finish last week?" | NEW: "shipped the billing page and fixed two bugs" -> {"facts": [], "procedures": []}
NEW: "make that shorter" -> {"facts": [], "procedures": []}
PROCEDURES: [{"id":"p1",...}] | NEW: "stop doing the weekly thing" -> {"facts": [], "procedures": [{"op":"delete","id":"p1"}]}`

// Turn raw model output into safe operations: known ids only, clean text, no duplicate adds,
// one decision per item (last wins), and an `expect` snapshot so stale writes can be rejected.
export function validateOps(raw, items, kind = 'fact') {
  const spec = KINDS[kind]
  const byId = new Map(items.map((x) => [x.id, x]))
  const known = new Set(items.map(spec.key))
  const out = []
  const slot = new Map() // item id -> index in out
  for (const o of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_OPS) break
    if (!o || typeof o !== 'object') continue
    if (o.op === 'add') {
      const item = Object.fromEntries(Object.entries(spec.fields).map(([f, max]) => [f, clean(o[f], max)]))
      if (Object.values(item).some((v) => !normalize(v))) continue
      const key = spec.key(item)
      if (known.has(key)) continue
      known.add(key)
      out.push({ op: 'add', ...item })
    } else if ((o.op === 'update' || o.op === 'delete') && byId.has(o.id)) {
      const existing = byId.get(o.id)
      let op = { op: 'delete', id: o.id, expect: spec.label(existing) }
      if (o.op === 'update') {
        // missing fields keep their current value (lets the model change only the instructions)
        const item = Object.fromEntries(Object.entries(spec.fields).map(([f, max]) => [f, clean(o[f], max) || existing[f]]))
        if (Object.values(item).some((v) => !normalize(v))) continue
        op = { op: 'update', id: o.id, expect: spec.label(existing), ...item }
      }
      if (slot.has(o.id)) out[slot.get(o.id)] = op
      else { slot.set(o.id, out.length); out.push(op) }
    }
  }
  return out
}

// Apply validated operations to an items array (pure; db.applyMemoryOps runs it inside a transaction).
// Returns { items, changed, skipped }. Skips: duplicates, stale writes (item changed since the
// decision was made), missing ids, no-op updates, and a full memory.
export function mergeItems(current, ops, { now = new Date().toISOString(), source = null, makeId = newId } = {}, kind = 'fact') {
  const spec = KINDS[kind]
  const items = current.map((x) => ({ ...x }))
  const changed = []
  const skipped = []
  const keyAt = (j) => spec.key(items[j])
  for (const o of ops) {
    if (o.op === 'add') {
      const key = spec.key(o)
      if (!key) { skipped.push({ ...o, reason: 'empty' }); continue }
      if (items.some((_, j) => keyAt(j) === key)) { skipped.push({ ...o, reason: 'duplicate' }); continue }
      if (items.length >= spec.max) { skipped.push({ ...o, reason: 'full' }); continue }
      const id = makeId()
      items.push({ id, ...pick(spec, o), createdAt: now, updatedAt: now, source })
      changed.push({ op: 'add', id, ...pick(spec, o) })
      continue
    }
    const i = items.findIndex((x) => x.id === o.id)
    if (i < 0) { skipped.push({ ...o, reason: 'missing' }); continue }
    if (o.expect !== undefined && spec.label(items[i]) !== o.expect) { skipped.push({ ...o, reason: 'stale' }); continue }
    if (o.op === 'delete') {
      changed.push({ op: 'delete', id: o.id, ...pick(spec, items[i]) })
      items.splice(i, 1)
      continue
    }
    if (normalize(spec.label(o)) === normalize(spec.label(items[i]))) { skipped.push({ ...o, reason: 'unchanged' }); continue }
    const dup = items.findIndex((_, j) => j !== i && keyAt(j) === spec.key(o))
    if (dup >= 0) {
      if (!spec.mergeDuplicateUpdate) { skipped.push({ ...o, reason: 'duplicate' }); continue }
      // the updated text already exists as another item: merge by removing this one
      changed.push({ op: 'delete', id: o.id, ...pick(spec, items[i]), mergedInto: spec.label(items[dup]) })
      items.splice(i, 1)
      continue
    }
    const old = spec.label(items[i])
    items[i] = { ...items[i], ...pick(spec, o), updatedAt: now, source, previous: [...(items[i].previous ?? []), old].slice(-5) }
    changed.push({ op: 'update', id: o.id, ...pick(spec, o), old })
  }
  return { items, changed, skipped }
}

export function mergeFacts(current, ops, opts) {
  const { items, changed, skipped } = mergeItems(current, ops, opts, 'fact')
  return { facts: items, changed, skipped }
}
export function mergeProcedures(current, ops, opts) {
  const { items, changed, skipped } = mergeItems(current, ops, opts, 'procedure')
  return { procedures: items, changed, skipped }
}

// Fallback when the decision call fails: apply explicit requests literally, so they are never lost.
export function requestsToOps(requests, facts) {
  return validateOps(requests.flatMap((r) =>
    r.action === 'forget' ? [{ op: 'delete', id: r.id }]
      : r.action !== 'remember' ? []
        : r.replaces_id ? [{ op: 'update', id: r.replaces_id, text: r.text }]
          : [{ op: 'add', text: r.text }]), facts, 'fact')
}
export function requestsToProcOps(requests, procedures) {
  return validateOps(requests.flatMap((r) =>
    r.action === 'forget_procedure' ? [{ op: 'delete', id: r.id }]
      : r.action !== 'learn_procedure' ? []
        : r.replaces_id ? [{ op: 'update', id: r.replaces_id, when: r.when, do: r.do }]
          : [{ op: 'add', when: r.when, do: r.do }]), procedures, 'procedure')
}

// The single memory decision. Returns { ok, ops, procOps, tokens }; ok=false means "could not decide".
export async function decideMemory({ user, text, previousReply = '', requests = [] }) {
  const facts = user.facts ?? []
  const procedures = user.procedures ?? []
  const prev = String(previousReply ?? '')
  const profile = { name: user.name, email: user.email, about: user.bio }
  const parts = [
    `EXISTING FACTS: ${JSON.stringify(facts.map(({ id, text }) => ({ id, text })))}`,
    `EXISTING PROCEDURES: ${JSON.stringify(procedures.map(({ id, when, do: d }) => ({ id, when, do: d })))}`,
    `PROFILE: ${JSON.stringify(profile)}`,
    `PREVIOUS ASSISTANT REPLY (${prev.length} chars): ${JSON.stringify(prev.length > 800 ? prev.slice(0, 800) + '…' : prev)}`,
    `NEW MESSAGE: ${JSON.stringify(text)}`,
    ...(requests.length ? [`EXPLICIT REQUESTS: ${JSON.stringify(requests)}`] : []),
  ]
  const { status, data } = await deepseek('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MEMORY_MODEL,
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: MEMORY_PROMPT }, { role: 'user', content: parts.join('\n') }],
    }),
  })
  const tokens = (data?.usage?.prompt_tokens ?? 0) + (data?.usage?.completion_tokens ?? 0)
  if (status !== 200) return { ok: false, ops: [], procOps: [], tokens, error: data?.error }
  let parsed
  try {
    parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '')
  } catch {
    return { ok: false, ops: [], procOps: [], tokens, error: 'Memory model returned invalid JSON' }
  }
  return {
    ok: true,
    ops: validateOps(parsed?.facts ?? parsed?.operations, facts, 'fact'),
    procOps: validateOps(parsed?.procedures, procedures, 'procedure'),
    tokens,
  }
}
