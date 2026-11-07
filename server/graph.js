// GRAPH MEMORY, kept as simple as it can be.
//
// Facts ("User works at Acme") are sentences. A graph stores the same knowledge as CONNECTIONS:
//     You --works_at--> Acme        You --managed_by--> Ana        Ana --lives_in--> Paris
// Each connection is an EDGE between two NODES (people, places, companies, pets...). Questions that
// need several facts joined ("which city does my manager live in?") become a WALK: start at You,
// follow managed_by to Ana, follow lives_in to Paris. Postgres can do the walk itself with a
// recursive query (db.walkGraph), so no graph database or extension is needed.
//
// Edges live in one jsonb column, users.edges (the app still has exactly two tables):
//   { id, from, fromKey, rel, to, toKey, since, until, source: {chatId} }
// `from`/`to` are display names, `fromKey`/`toKey` are the normalized names used to match nodes
// ("Ana", "ana " and "ANA" are one node). `until` is null while the edge is true; when something
// stops being true the edge is closed with a date, not deleted, so history is kept.
import { randomUUID } from 'node:crypto'
import { deepseek } from './deepseek.js'
import { MEMORY_MODEL } from './memory.js'

export const graphOn = () => process.env.GRAPH_MEMORY !== 'off'
export const MAX_EDGES = 300
export const MAX_NAME = 60

// A person has one home, one employer, one manager: a new value REPLACES the old one (the old edge
// is closed). Everything else (pets, friends, hobbies) can have many values at once.
export const SINGLE_VALUED = new Set(['lives_in', 'works_at', 'works_as', 'managed_by', 'married_to'])

const SELF = new Set(['you', 'me', 'i', 'myself', 'user', 'the user'])

// "Ana", " ana", "ANA!" -> "ana". The user is always the node "you".
export function nodeKey(name) {
  const k = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return SELF.has(k) ? 'you' : k
}
export const nodeName = (name) => (nodeKey(name) === 'you' ? 'You' : String(name).trim().replace(/\s+/g, ' ').slice(0, MAX_NAME))

// "Works At" / "works at" -> "works_at"
export const relKey = (rel) => String(rel ?? '').toLowerCase().replace(/[^a-z\s_]/g, '').trim().replace(/[\s_]+/g, '_').slice(0, 30)

// Validate what the model returned: keep only well-formed triples, at most 8.
export function cleanTriples(raw) {
  const out = []
  for (const t of Array.isArray(raw) ? raw : []) {
    if (!t || typeof t !== 'object') continue
    if (typeof t.from !== 'string' || typeof t.to !== 'string' || typeof (t.relation ?? t.rel) !== 'string') continue
    const from = nodeName(t.from), to = nodeName(t.to), rel = relKey(t.relation ?? t.rel)
    const fromKey = nodeKey(from), toKey = nodeKey(to)
    if (!fromKey || !toKey || !rel || fromKey === toKey) continue
    if (String(t.from).length > MAX_NAME * 2 || String(t.to).length > MAX_NAME * 2) continue
    out.push({ from, fromKey, rel, to, toKey, ended: t.ended === true })
    if (out.length >= 8) break
  }
  return out
}

const describe = (e) => ({ id: e.id, from: e.from, rel: e.rel, to: e.to })

// Apply triples to the current edges. Pure: returns the new edge list and what changed.
//   duplicate of a true edge         -> skipped
//   single-valued relation, new value -> old edge closed ("end"), new edge added
//   ended: true                       -> matching true edge closed
export function mergeEdges(edges, triples, { chatId = null, now = new Date().toISOString() } = {}) {
  const out = edges.map((e) => ({ ...e }))
  const changed = []
  for (const t of triples) {
    const active = out.filter((e) => !e.until)
    if (t.ended) {
      for (const e of active) {
        if (e.fromKey === t.fromKey && e.rel === t.rel && e.toKey === t.toKey) { e.until = now; changed.push({ op: 'end', ...describe(e) }) }
      }
      continue
    }
    if (active.some((e) => e.fromKey === t.fromKey && e.rel === t.rel && e.toKey === t.toKey)) continue
    if (SINGLE_VALUED.has(t.rel)) {
      for (const e of active) {
        if (e.fromKey === t.fromKey && e.rel === t.rel) { e.until = now; changed.push({ op: 'end', ...describe(e) }) }
      }
    }
    const edge = { id: randomUUID(), from: t.from, fromKey: t.fromKey, rel: t.rel, to: t.to, toKey: t.toKey, since: now, until: null, source: { chatId } }
    out.push(edge)
    changed.push({ op: 'add', ...describe(edge) })
  }
  // Keep the column small: when over the limit, drop the oldest CLOSED edges first.
  if (out.length > MAX_EDGES) {
    const closed = out.filter((e) => e.until).sort((a, b) => a.until.localeCompare(b.until))
    for (const e of closed) { if (out.length <= MAX_EDGES) break; out.splice(out.indexOf(e), 1) }
  }
  return { edges: out, changed }
}

const PROMPT = `You turn a user's message into GRAPH EDGES: short facts shaped (from, relation, to) about the people, places, organisations, pets and things in the user's life.

Rules:
1. "from" and "to" are names. The user themself is always "You".
2. "relation" is a short snake_case phrase: lives_in, works_at, works_as, managed_by, married_to, sister_of, friend_of, has_pet, studies_at, owns, likes. Reuse relation names and name spellings from EXISTING EDGES when they fit.
3. Only lasting facts the USER states in this message. Skip questions, small talk, requests for help and anything the assistant said.
4. When the user says something stopped being true ("I left Acme", "we broke up"), return that edge with "ended": true.
5. A fact about someone else is an edge from THEM: "My manager Ana lives in Paris" gives You managed_by Ana, and Ana lives_in Paris.
6. If there are no such facts, return {"edges": []}.

Reply with JSON only: {"edges":[{"from":"You","relation":"works_at","to":"Acme"}]}

Examples:
"I moved to Berlin last week" -> {"edges":[{"from":"You","relation":"lives_in","to":"Berlin"}]}
"My manager Ana lives in Paris" -> {"edges":[{"from":"You","relation":"managed_by","to":"Ana"},{"from":"Ana","relation":"lives_in","to":"Paris"}]}
"I quit Acme" -> {"edges":[{"from":"You","relation":"works_at","to":"Acme","ended":true}]}
"What's the weather like?" -> {"edges":[]}`

// One small model call per message. It runs in parallel with the reply, so it adds no wait.
export async function extractTriples({ text, previousReply = '', existing = [] }) {
  const parts = []
  const active = existing.filter((e) => !e.until).slice(-60)
  parts.push('EXISTING EDGES:\n' + (active.length ? active.map((e) => `${e.from} ${e.rel} ${e.to}`).join('\n') : '(none)'))
  if (previousReply) parts.push(`The assistant's previous reply (context only, do not extract from it):\n${previousReply.slice(0, 400)}`)
  parts.push(`USER MESSAGE:\n${text}`)
  const { status, data } = await deepseek('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MEMORY_MODEL, temperature: 0, max_tokens: 500, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: parts.join('\n\n') }],
    }),
  })
  if (status !== 200) return { ok: false, error: data?.error ?? `status ${status}`, triples: [], tokens: 0 }
  let parsed
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') } catch { return { ok: false, error: 'bad JSON', triples: [], tokens: 0 } }
  const u = data.usage ?? {}
  return { ok: true, triples: cleanTriples(parsed.edges), tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) }
}

// A small example graph for the Graph lab, so there is something to walk without chatting first.
export const EXAMPLE_TRIPLES = cleanTriples([
  { from: 'You', relation: 'works_at', to: 'Acme' },
  { from: 'You', relation: 'managed_by', to: 'Ana' },
  { from: 'Ana', relation: 'lives_in', to: 'Paris' },
  { from: 'Ana', relation: 'married_to', to: 'Marc' },
  { from: 'Marc', relation: 'works_at', to: 'Louvre' },
  { from: 'You', relation: 'lives_in', to: 'Lyon' },
  { from: 'You', relation: 'has_pet', to: 'Rex' },
  { from: 'Rex', relation: 'is_a', to: 'Beagle' },
])
