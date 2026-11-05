// Server-side API (runs inside Vite's dev server). The browser never sees the key.
// Storage is Postgres (server/db.js): `users` holds the profile, `chats` holds each chat
// session with its full message history.
//
// What the model gets on every message:
//   1. system message: instructions + the user's profile + today's date
//   2. this chat's previous history (short-term / working memory)
//   3. the new message
//   4. TOOLS it may call to search the user's OTHER chats (episodic memory).
//      If it calls one, the server runs it, sends the results back, and the model
//      answers with them (the "tool loop" below).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as db from './db.js'

const DEEPSEEK = 'https://api.deepseek.com'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i // also guards "new"
const MAX_TOOL_ROUNDS = 4

// ---------- prompt ----------
const SYSTEM = 'You are a helpful assistant. Keep answers short and clear.'

function systemPrompt(user) {
  const lines = [`- Name: ${user.name}`]
  if (user.email) lines.push(`- Email: ${user.email}`)
  if (user.bio) lines.push(`- About them: ${user.bio}`)
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const facts = (user.facts ?? []).map((f) => `- [${f.id}] ${f.text}`)
  return `${SYSTEM}

You are talking to this user (from their saved profile):
${lines.join('\n')}

Long-term facts you remember about them (id in brackets; newest knowledge wins):
${facts.length ? facts.join('\n') : '(none yet)'}
Use these naturally when it helps (e.g. greet them by name, respect allergies and preferences). If they ask what you know about them, tell them.

YOUR MEMORY WORKS IN TWO WAYS:
1. Automatic: after every message, lasting facts the user shares about themselves are saved in the background.
   You do not need to do anything for that, and you can truthfully tell the user you will remember such things.
2. On request: when the user explicitly asks you to remember, correct or forget something, call remember_fact
   (with replaces_id to correct an existing fact) or forget_fact (with the fact's id), then confirm briefly.
Never claim you cannot remember things.

Today is ${today}.

You can only see THIS chat's messages directly. The user has other, earlier chats with you.
When they refer to something from before ("last time", "earlier", "remember when", "what did I tell you about...",
"what did we talk about yesterday"), or when you need a detail they may have mentioned in another chat,
call search_past_chats or list_recent_chats first, then answer from what you find.
Say which earlier chat the information came from. If nothing is found, say so; never invent past conversations.`
}

// ---------- tools (episodic memory over past chats) ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_past_chats',
      description:
        "Full-text search over the user's earlier chats with you (not the current chat). " +
        'Returns matching messages with the chat title, date, and the messages around them. ' +
        'Use short keyword queries, e.g. "cat name", "Kyoto trip", "allergy". Try another wording if nothing is found.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search for' },
          limit: { type: 'integer', description: 'Max results, 1-10 (default 6)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_chats',
      description:
        "List the user's earlier chats from the last N days (not the current chat): title, start date, " +
        'last message date, size, and the first message. Use for "what did we talk about yesterday / this week".',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: 'How many days back, 1-90 (default 7)' } },
      },
    },
  },
  // semantic memory on request (the "hot path"); the background extractor covers everything else
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        'Save a long-term fact about the user, ONLY when they explicitly ask you to remember or correct something. ' +
        'Write it as one short third-person sentence starting with "User". To correct an existing fact, pass its id as replaces_id.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact, e.g. "User likes Thai food"' },
          replaces_id: { type: 'string', description: 'Id of an existing fact this one replaces (optional)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_fact',
      description: 'Delete a remembered fact when the user explicitly asks you to forget it or says it is no longer true.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id of the fact to forget (from the facts list)' } },
        required: ['id'],
      },
    },
  },
]
const MEMORY_TOOLS = new Set(['remember_fact', 'forget_fact'])

async function runTool(name, args, { userId, chatId, memoryChanges }) {
  const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? Math.round(+n) : d))
  if (name === 'remember_fact' || name === 'forget_fact') {
    const op = name === 'forget_fact' ? { op: 'delete', id: String(args.id ?? '') }
      : args.replaces_id ? { op: 'update', id: String(args.replaces_id), text: String(args.text ?? '').trim().slice(0, 200) }
        : { op: 'add', text: String(args.text ?? '').trim().slice(0, 200) }
    if (op.op !== 'delete' && !op.text) return { error: 'text is required' }
    const changed = await db.applyFactOps(userId, [op], { chatId, via: 'tool' })
    memoryChanges.push(...changed.map((c) => ({ ...c, source: 'tool' })))
    return changed.length
      ? { ok: true, changed }
      : { ok: false, note: op.op === 'add' ? 'Already remembered' : 'No fact with that id' }
  }
  if (name === 'search_past_chats') {
    const query = String(args.query ?? '').trim()
    if (!query) return { error: 'query is required' }
    const results = await db.searchPastChats(userId, chatId, query, clamp(args.limit, 1, 10, 6))
    return { query, count: results.length, results }
  }
  if (name === 'list_recent_chats') {
    const days = clamp(args.days, 1, 90, 7)
    const chats = await db.listRecentChats(userId, chatId, days)
    return { days, count: chats.length, chats }
  }
  return { error: `Unknown tool ${name}` }
}

// ---------- semantic memory: learn durable facts about the user ----------
// A second, cheap model call per message (runs in parallel with the reply). It sees the facts
// we already have and the user's new message, and decides add / update / delete (Mem0-style),
// so "I moved to Berlin" UPDATES "Lives in Pune" instead of storing both.
const EXTRACT_MODEL = 'deepseek-flash'
const EXTRACT_PROMPT = `You maintain the long-term memory of an assistant: short facts about the USER that will still
matter in future conversations (who they are, where they live, work, family, pets, health/allergies,
diet, goals, plans, strong likes and dislikes, recurring situations).

You get the EXISTING facts (with ids), the user's PROFILE, the assistant's PREVIOUS reply (context only),
and the user's NEW message. Return json: {"operations": [...]} where each operation is one of
  {"op": "add", "text": "<fact>"}
  {"op": "update", "id": "<existing id>", "text": "<corrected fact>"}   (the new message changes or refines it)
  {"op": "delete", "id": "<existing id>"}                              (the user says it is no longer true)

Rules:
- Only facts the USER states or clearly confirms about themselves. Never facts from the assistant's words alone.
- Questions, greetings, small talk, one-off moods, the weather, and requests for help -> {"operations": []}.
- Do not repeat what the PROFILE or EXISTING facts already say. Prefer update over add when it is the same topic.
- Each fact: one short sentence in third person, starting with "User", e.g. "User is allergic to peanuts".
- When in doubt, do nothing.

Examples:
EXISTING: [] | NEW: "what's the capital of France?" -> {"operations": []}
EXISTING: [] | NEW: "ugh, so tired today lol" -> {"operations": []}
EXISTING: [{"id":"a1","text":"User lives in Pune"}] | NEW: "I just moved to Berlin and started at Zalando"
  -> {"operations": [{"op":"update","id":"a1","text":"User lives in Berlin"},{"op":"add","text":"User works at Zalando"}]}
EXISTING: [{"id":"b2","text":"User has a dog called Max"}] | NEW: "Max passed away last month"
  -> {"operations": [{"op":"update","id":"b2","text":"User's dog Max passed away"}]}`

async function extractFacts(user, text, previousReply) {
  const existing = (user.facts ?? []).map(({ id, text }) => ({ id, text }))
  const profile = { name: user.name, email: user.email, about: user.bio }
  const { status, data } = await deepseek('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        {
          role: 'user',
          content: `EXISTING: ${JSON.stringify(existing)}\nPROFILE: ${JSON.stringify(profile)}\n` +
            `PREVIOUS ASSISTANT REPLY: ${JSON.stringify((previousReply ?? '').slice(0, 500))}\nNEW MESSAGE: ${JSON.stringify(text)}`,
        },
      ],
    }),
  })
  if (status !== 200) return { ops: [], tokens: 0 }
  let ops = []
  try { ops = JSON.parse(data.choices?.[0]?.message?.content ?? '{}').operations ?? [] } catch {}
  const ids = new Set(existing.map((f) => f.id))
  const clean = (s) => String(s ?? '').trim().slice(0, 200)
  ops = ops.filter((o) =>
    (o?.op === 'add' && clean(o.text)) ||
    (o?.op === 'update' && ids.has(o.id) && clean(o.text)) ||
    (o?.op === 'delete' && ids.has(o.id)),
  ).map((o) => ({ op: o.op, id: o.id, text: clean(o.text) }))
  return { ops, tokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0) }
}

// ---------- key + DeepSeek ----------
function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    return execFileSync('security',
      ['find-generic-password', '-a', process.env.USER, '-s', 'deepseek-api-key', '-w'],
      { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

async function deepseek(urlPath, init = {}) {
  const key = apiKey()
  if (!key) return { status: 500, data: { error: 'No DeepSeek key found (env DEEPSEEK_API_KEY or Keychain "deepseek-api-key").' } }
  const r = await fetch(DEEPSEEK + urlPath, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) return { status: r.status, data: { error: data?.error?.message || `DeepSeek returned ${r.status}` } }
  return { status: 200, data }
}

// Call the model; whenever it asks for tools, run them and call it again with the results.
async function answerWithTools({ model, messages, ctx }) {
  const convo = [...messages]
  const toolCalls = []
  const usage = { prompt: 0, out: 0 }
  let rounds = 0

  while (true) {
    const allowTools = rounds < MAX_TOOL_ROUNDS
    const { status, data } = await deepseek('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model, messages: convo, max_tokens: 1000, ...(allowTools && { tools: TOOLS }) }),
    })
    if (status !== 200) return { status, data }
    rounds++
    usage.prompt += data.usage?.prompt_tokens ?? 0
    usage.out += data.usage?.completion_tokens ?? 0

    const msg = data.choices?.[0]?.message ?? {}
    if (!msg.tool_calls?.length) {
      return { status: 200, reply: msg.content ?? '', model: data.model, usage, toolCalls, rounds }
    }

    // The model wants tools: echo its message back (incl. reasoning), then one result per call.
    convo.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.reasoning_content && { reasoning_content: msg.reasoning_content }),
      tool_calls: msg.tool_calls,
    })
    for (const call of msg.tool_calls) {
      let args = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch {}
      const result = await runTool(call.function.name, args, ctx).catch((e) => ({ error: String(e.message || e) }))
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      if (MEMORY_TOOLS.has(call.function.name)) continue // shown in the UI as memory changes instead
      toolCalls.push({
        name: call.function.name,
        args,
        count: result.count ?? 0,
        error: result.error,
        // what the UI shows: which earlier chats were found
        found: (result.results ?? result.chats ?? []).map((r) => ({
          chat: r.chat ?? r.title,
          date: r.date ?? r.lastMessage,
          snippet: (r.message ?? r.firstMessage ?? '').slice(0, 140),
        })),
      })
    }
  }
}

// ---------- http helpers ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch (e) { reject(e) } })
  })
}
function send(res, status, data) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean) // e.g. ['chats', '<id>', 'messages']
  const user = await db.currentUser()

  // GET /api/models
  if (req.method === 'GET' && parts[0] === 'models') {
    const { status, data } = await deepseek('/models')
    return send(res, status, status === 200 ? { models: data.data.map((m) => m.id) } : data)
  }

  // DELETE /api/profile/facts/:id  -> forget one learned fact
  if (req.method === 'DELETE' && parts[0] === 'profile' && parts[1] === 'facts' && parts[2]) {
    return send(res, 200, await db.deleteFact(user.id, parts[2]))
  }

  // GET /api/profile, PUT /api/profile {name, email, bio}
  if (parts[0] === 'profile' && !parts[1]) {
    if (req.method === 'GET') return send(res, 200, user)
    if (req.method === 'PUT') {
      const { name, email, bio } = await readJson(req)
      const clean = { name: String(name ?? '').trim(), email: String(email ?? '').trim(), bio: String(bio ?? '').trim() }
      if (!clean.name) return send(res, 400, { error: 'Name is required' })
      if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) return send(res, 400, { error: 'That email does not look valid' })
      try {
        return send(res, 200, await db.updateUser(user.id, clean))
      } catch (e) {
        if (e.code === '23505') return send(res, 409, { error: 'That email is already used by another user' })
        throw e
      }
    }
  }

  // GET /api/chats  -> this user's chats, newest first
  if (req.method === 'GET' && parts[0] === 'chats' && !parts[1]) {
    return send(res, 200, { chats: await db.listChats(user.id) })
  }

  // GET /api/chats/:id  -> one chat with its full history
  if (req.method === 'GET' && parts[0] === 'chats' && parts[1]) {
    const chat = UUID.test(parts[1]) && await db.getChat(user.id, parts[1])
    return chat ? send(res, 200, chat) : send(res, 404, { error: 'Chat not found' })
  }

  // DELETE /api/chats/:id
  if (req.method === 'DELETE' && parts[0] === 'chats' && parts[1]) {
    if (UUID.test(parts[1])) await db.deleteChat(user.id, parts[1])
    return send(res, 200, { ok: true })
  }

  // POST /api/chats/:id/messages  (id "new" starts a chat)  body: { model, content }
  if (req.method === 'POST' && parts[0] === 'chats' && parts[2] === 'messages') {
    const { model, content } = await readJson(req)
    const text = String(content || '').trim()
    if (!text) return send(res, 400, { error: 'Empty message' })

    const existing = UUID.test(parts[1]) ? await db.getChat(user.id, parts[1]) : null
    if (parts[1] !== 'new' && !existing) return send(res, 404, { error: 'Chat not found' })
    const chat = existing ?? { id: randomUUID(), title: text.slice(0, 50), messages: [] }

    // Profile (system message) + previous history of THIS chat (from Postgres) + the new message.
    const prompt = [
      { role: 'system', content: systemPrompt(user) },
      ...chat.messages.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: text },
    ]

    const t = Date.now()
    const previousReply = chat.messages.findLast((m) => m.role === 'assistant')?.content
    const ctx = { userId: user.id, chatId: chat.id, memoryChanges: [] } // memory tools record changes here
    // Reply and memory extraction run at the same time, so learning adds almost no wait.
    const [out, learned] = await Promise.all([
      answerWithTools({ model, messages: prompt, ctx }),
      extractFacts(user, text, previousReply).catch(() => ({ ops: [], tokens: 0 })),
    ])
    if (out.status !== 200) return send(res, out.status, out.data) // nothing saved if the call failed

    // Hybrid memory merge. The chat model's explicit remember/forget calls win:
    //  - background ops on a fact the tools already touched are dropped (no fighting),
    //  - background ADDs are dropped when the tools saved something (no near-duplicates),
    //  - other background updates/deletes still apply, so a request the tool only half-handled
    //    ("forget my drink AND my hiking") is still completed.
    const toolTouched = new Set(ctx.memoryChanges.map((c) => c.id))
    const toolSaved = ctx.memoryChanges.some((c) => c.op !== 'delete')
    const bgOps = learned.ops.filter((o) => !toolTouched.has(o.id) && !(o.op === 'add' && toolSaved))
    const auto = bgOps.length
      ? (await db.applyFactOps(user.id, bgOps, { chatId: chat.id, via: 'auto' })).map((c) => ({ ...c, source: 'auto' }))
      : []
    const memory = [...ctx.memoryChanges, ...auto]
    const usedTools = ctx.memoryChanges.length > 0

    const now = new Date().toISOString()
    const saved = await db.saveTurn({
      userId: user.id,
      chatId: chat.id,
      title: chat.title,
      turn: [
        { role: 'user', content: text, at: now },
        {
          role: 'assistant',
          content: out.reply,
          at: new Date().toISOString(),
          meta: {
            model: out.model,
            promptTokens: out.usage.prompt,
            outTokens: out.usage.out,
            ms: Date.now() - t,
            contextMessages: prompt.length - 1, // previous history + new message, excluding system
            profile: user.name,
            modelCalls: out.rounds,
            toolCalls: out.toolCalls,
            factsInPrompt: user.facts?.length ?? 0,
            memory,                       // what semantic memory changed: [{op, text, old?, source: 'tool'|'auto'}]
            backgroundSkipped: usedTools ? learned.ops.length - bgOps.length : 0,
            memoryTokens: learned.tokens, // cost of the extraction call
          },
        },
      ],
    })
    return send(res, 200, saved)
  }

  send(res, 404, { error: 'Not found' })
}

export const deepseekApi = {
  name: 'deepseek-api',
  configureServer(server) {
    server.middlewares.use('/api', (req, res) =>
      handle(req, res).catch((e) => send(res, 500, { error: String(e.message || e) })))
  },
}
