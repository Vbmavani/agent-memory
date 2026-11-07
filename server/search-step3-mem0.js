// STEP 3 of learning memory search: a ready-made memory layer, mem0 (hosted platform).
//
// Steps 1 and 2 search whole chats and their messages, which we store and index ourselves.
// mem0 works differently: after every turn we send it the new messages, and IT decides what is worth
// remembering. It pulls out short memories ("User's cat is named Pixel"), merges them with what it
// already has (add / update / delete, like our single writer in server/memory.js), embeds and stores
// them on its side. Searching returns those short memories, not chat messages.
//
// The API key comes from env MEM0_API_KEY, else the macOS Keychain entry "mem0-api-key"; it is never
// stored in a file. MEM0=off stops sending chats to mem0. Note: with mem0 on, every saved turn of
// chat is sent to mem0's cloud service.
import { execFileSync } from 'node:child_process'
import { pool } from './db.js'

// mem0's client sends usage telemetry unless this is set before it loads.
process.env.MEM0_TELEMETRY = 'false'

// mem0's scores run lower than our cosine similarities. From `npm run search:compare` on real chats:
// "what is my pet called" -> "User's cat is called Pixel" 0.42; the "3 bullets" rule 0.22; noise 0.14-0.19.
export const MIN_MEM0_SCORE = 0.15    // the model asked to search: show plausible matches
export const MIN_MEM0_RECALL = 0.25   // added to the prompt unasked: only clear matches

function apiKey() {
  if (process.env.MEM0_API_KEY) return process.env.MEM0_API_KEY
  try {
    return execFileSync('security', ['find-generic-password', '-a', process.env.USER, '-s', 'mem0-api-key', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

let client
async function mem0() {
  client ??= (async () => {
    const key = apiKey()
    if (!key) throw new Error('No mem0 key: set MEM0_API_KEY or the Keychain entry "mem0-api-key".')
    const { default: MemoryClient } = await import('mem0ai')
    return new MemoryClient({ apiKey: key })
  })().catch((e) => { client = null; throw e })
  return client
}

export const mem0Enabled = () => process.env.MEM0 !== 'off' && Boolean(apiKey())

// One mem0 user per app user. The id is our users.id (a random uuid), so no name or email is sent.
const mem0UserId = (userId) => `agent-memory-${userId}`

// WRITE: after every saved turn, send the new user message and reply. mem0 processes it in the
// background (the call returns "PENDING" straight away) and updates its memories a few seconds later.
// `timestamp` (seconds) tells mem0 when the conversation happened; without it, mem0 dates every
// memory "now", so imported old chats read as if they were said today.
export async function rememberInMem0(userId, chatId, messages, { timestamp } = {}) {
  const clean = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim())
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
  if (!clean.length) return null
  const at = timestamp ?? Date.parse(messages.find((m) => m.at)?.at ?? '') / 1000
  return (await mem0()).add(clean, {
    userId: mem0UserId(userId), metadata: { chatId },
    ...(Number.isFinite(at) && { timestamp: Math.floor(at) }),
  })
}

// READ: mem0's closest memories for the query. Results get the same shape as steps 1 and 2, so the
// tool, the UI and auto-recall need no special handling. `message` is the memory itself.
export async function searchMem0(userId, query, { limit = 6, min = MIN_MEM0_SCORE } = {}) {
  const { results = [] } = await (await mem0()).search(query, {
    filters: { user_id: mem0UserId(userId) },
    topK: limit,
  })
  const hits = results.filter((m) => (m.score ?? 0) >= min)
  // Name the chat each memory came from (the chatId we sent as metadata).
  const ids = [...new Set(hits.map((m) => m.metadata?.chatId).filter(Boolean))]
  const titles = new Map()
  if (ids.length) {
    const { rows } = await pool.query('SELECT id, title FROM chats WHERE user_id = $1 AND id = ANY($2::uuid[])', [userId, ids])
    rows.forEach((r) => titles.set(r.id, r.title))
  }
  return hits.map((m) => ({
    chat: titles.get(m.metadata?.chatId) ?? 'mem0 memory',
    chatId: m.metadata?.chatId ?? null,
    date: m.createdAt ?? m.updatedAt ?? null, // createdAt follows the timestamp we sent; updatedAt is when mem0 last changed it
    role: 'memory',
    message: m.memory,
    before: null,
    after: null,
    similarity: +(m.score ?? 0).toFixed(2),
    matchedBy: 'mem0',
  }))
}

// Everything mem0 remembers about this user (for the import script and for looking at it).
export async function allMem0Memories(userId) {
  const res = await (await mem0()).getAll({ filters: { user_id: mem0UserId(userId) }, pageSize: 200 })
  return res.results ?? res
}

export async function resetMem0(userId) {
  return (await mem0()).deleteUsers({ userId: mem0UserId(userId) })
}
