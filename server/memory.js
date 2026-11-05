// Semantic memory: long-term facts about the user, stored in users.facts.
//
// ONE WRITER. Every message gets exactly one memory decision, made by one model call that sees
// everything at once: the existing facts, the user's message, and any explicit requests the chat
// model recorded via remember_fact / forget_fact. The chat model's tools never write directly;
// they only record requests. That is what stops two writers from creating overlapping facts
// (e.g. one adding "User is in France" while the other updates "User lives in Lyon").
//
// Flow per message:
//   1. In parallel with the reply, decide speculatively from the message alone (no extra wait).
//   2. If the chat model recorded explicit requests, decide again WITH them (one decision wins).
//   3. Validate the operations, then apply them in one transaction (db.applyFactOps -> mergeFacts),
//      which also rejects stale writes and near-duplicates.
import { randomUUID } from 'node:crypto'
import { deepseek } from './deepseek.js'

export const MEMORY_MODEL = 'deepseek-flash'
export const MAX_FACTS = 100
const MAX_FACT_LEN = 200
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
const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LEN)

export const MEMORY_PROMPT = `You maintain the long-term memory of an assistant: short facts about the USER that will still
matter in future conversations (who they are, where they live, work, family, pets, health/allergies,
diet, goals, plans, strong likes and dislikes, recurring situations).

You get EXISTING facts (with ids), the user's PROFILE, the assistant's PREVIOUS reply (context only),
the user's NEW message, and sometimes EXPLICIT REQUESTS (what the user explicitly asked to remember,
correct or forget, as recorded by the assistant). Return json: {"operations": [...]} with ops:
  {"op": "add", "text": "<fact>"}
  {"op": "update", "id": "<existing id>", "text": "<new full fact>"}
  {"op": "delete", "id": "<existing id>"}

Rules:
1. ONE FACT PER ATTRIBUTE (home city/country, job, each pet, each preference, each allergy...).
   If the new information is about an attribute an existing fact already covers, UPDATE that fact,
   combining both when they are compatible ("lives in Lyon" + "in France" -> "lives in Lyon, France"),
   or do nothing if it is already implied. Never add a second fact about the same attribute.
2. Only facts the USER states or clearly confirms about themselves, never from the assistant's words alone.
3. Questions, greetings, small talk, one-off moods, the weather and requests for help -> {"operations": []}.
4. Do not repeat the PROFILE. If the user says something is no longer true, DELETE (or UPDATE) it.
5. EXPLICIT REQUESTS must all be honored, but still follow rule 1: "remember X" where an existing fact
   covers X becomes an UPDATE of that fact (or nothing if exactly covered); "forget X" becomes DELETE
   of every matching fact. Also handle anything else in the NEW message (e.g. a second thing to forget).
6. Each fact is one short third-person sentence starting with "User". When in doubt, do nothing.

Examples:
EXISTING: [] | NEW: "what's the capital of France?" -> {"operations": []}
EXISTING: [{"id":"a1","text":"User lives in Pune"}] | NEW: "I just moved to Berlin and started at Zalando"
  -> {"operations": [{"op":"update","id":"a1","text":"User lives in Berlin"},{"op":"add","text":"User works at Zalando"}]}
EXISTING: [{"id":"c3","text":"User lives in Lyon"}] | NEW: "remember that I'm in France"
  | REQUESTS: [{"action":"remember","text":"User is in France"}]
  -> {"operations": [{"op":"update","id":"c3","text":"User lives in Lyon, France"}]}
EXISTING: [{"id":"d4","text":"User's favourite drink is chai"},{"id":"e5","text":"User goes hiking every weekend"}]
  | NEW: "forget my favourite drink and that I hike" | REQUESTS: [{"action":"forget","id":"d4"}]
  -> {"operations": [{"op":"delete","id":"d4"},{"op":"delete","id":"e5"}]}`

// Turn raw model output into safe operations: known ids only, clean text, no duplicate adds,
// one decision per fact (last wins), and an `expect` snapshot so stale writes can be rejected.
export function validateOps(raw, facts) {
  const byId = new Map(facts.map((f) => [f.id, f]))
  const known = new Set(facts.map((f) => normalize(f.text)))
  const out = []
  const slot = new Map() // fact id -> index in out
  for (const o of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_OPS) break
    if (!o || typeof o !== 'object') continue
    if (o.op === 'add') {
      const text = cleanText(o.text)
      const key = normalize(text)
      if (!key || known.has(key)) continue
      known.add(key)
      out.push({ op: 'add', text })
    } else if ((o.op === 'update' || o.op === 'delete') && byId.has(o.id)) {
      const text = o.op === 'update' ? cleanText(o.text) : undefined
      if (o.op === 'update' && !normalize(text)) continue
      const op = { op: o.op, id: o.id, expect: byId.get(o.id).text, ...(text && { text }) }
      if (slot.has(o.id)) out[slot.get(o.id)] = op
      else { slot.set(o.id, out.length); out.push(op) }
    }
  }
  return out
}

// Apply validated operations to a facts array (pure; db.applyFactOps runs it inside a transaction).
// Returns { facts, changed, skipped }. Skips: duplicates, stale writes (fact changed since the
// decision was made), missing ids, no-op updates, and a full memory.
export function mergeFacts(current, ops, { now = new Date().toISOString(), source = null, makeId = newId } = {}) {
  const facts = current.map((f) => ({ ...f }))
  const changed = []
  const skipped = []
  const keyAt = (j) => normalize(facts[j].text)
  for (const o of ops) {
    if (o.op === 'add') {
      const key = normalize(o.text)
      if (!key) { skipped.push({ ...o, reason: 'empty' }); continue }
      if (facts.some((_, j) => keyAt(j) === key)) { skipped.push({ ...o, reason: 'duplicate' }); continue }
      if (facts.length >= MAX_FACTS) { skipped.push({ ...o, reason: 'full' }); continue }
      const id = makeId()
      facts.push({ id, text: o.text, createdAt: now, updatedAt: now, source })
      changed.push({ op: 'add', id, text: o.text })
      continue
    }
    const i = facts.findIndex((f) => f.id === o.id)
    if (i < 0) { skipped.push({ ...o, reason: 'missing' }); continue }
    if (o.expect !== undefined && facts[i].text !== o.expect) { skipped.push({ ...o, reason: 'stale' }); continue }
    if (o.op === 'delete') {
      changed.push({ op: 'delete', id: o.id, text: facts[i].text })
      facts.splice(i, 1)
      continue
    }
    if (normalize(o.text) === keyAt(i)) { skipped.push({ ...o, reason: 'unchanged' }); continue }
    const dup = facts.findIndex((_, j) => j !== i && keyAt(j) === normalize(o.text))
    if (dup >= 0) {
      // the updated text already exists as another fact: merge by removing this one
      changed.push({ op: 'delete', id: o.id, text: facts[i].text, mergedInto: facts[dup].text })
      facts.splice(i, 1)
      continue
    }
    const old = facts[i].text
    facts[i] = { ...facts[i], text: o.text, updatedAt: now, source, previous: [...(facts[i].previous ?? []), old].slice(-5) }
    changed.push({ op: 'update', id: o.id, text: o.text, old })
  }
  return { facts, changed, skipped }
}

// Fallback when the decision call fails: apply explicit requests literally, so they are never lost.
export function requestsToOps(requests, facts) {
  return validateOps(requests.map((r) =>
    r.action === 'forget' ? { op: 'delete', id: r.id }
      : r.replaces_id ? { op: 'update', id: r.replaces_id, text: r.text }
        : { op: 'add', text: r.text }), facts)
}

// The single memory decision. Returns { ok, ops, tokens }; ok=false means "could not decide".
export async function decideMemory({ user, text, previousReply = '', requests = [] }) {
  const facts = user.facts ?? []
  const existing = facts.map(({ id, text }) => ({ id, text }))
  const profile = { name: user.name, email: user.email, about: user.bio }
  const parts = [
    `EXISTING: ${JSON.stringify(existing)}`,
    `PROFILE: ${JSON.stringify(profile)}`,
    `PREVIOUS ASSISTANT REPLY: ${JSON.stringify(String(previousReply ?? '').slice(0, 500))}`,
    `NEW MESSAGE: ${JSON.stringify(text)}`,
    ...(requests.length ? [`EXPLICIT REQUESTS: ${JSON.stringify(requests)}`] : []),
  ]
  const { status, data } = await deepseek('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MEMORY_MODEL,
      temperature: 0,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: MEMORY_PROMPT }, { role: 'user', content: parts.join('\n') }],
    }),
  })
  const tokens = (data?.usage?.prompt_tokens ?? 0) + (data?.usage?.completion_tokens ?? 0)
  if (status !== 200) return { ok: false, ops: [], tokens, error: data?.error }
  let raw
  try {
    raw = JSON.parse(data.choices?.[0]?.message?.content ?? '').operations
  } catch {
    return { ok: false, ops: [], tokens, error: 'Memory model returned invalid JSON' }
  }
  return { ok: true, ops: validateOps(raw, facts), tokens }
}
