// Server-side API (runs inside Vite's dev server). The browser never sees the key.
// Storage is Postgres (server/db.js): `users` holds the profile and learned facts, `chats` holds
// each chat session with its full message history.
//
// What the model gets on every message:
//   1. system message: instructions + profile + learned facts (semantic memory) + today's date
//   2. this chat's previous history (short-term / working memory)
//   3. the new message
//   4. TOOLS: search the user's OTHER chats (episodic memory), and record explicit
//      remember / forget requests for facts (semantic memory) and procedures (procedural memory),
//      applied by server/memory.js after the reply
import { randomUUID } from 'node:crypto'
import * as db from './db.js'
import { deepseek } from './deepseek.js'
import * as memory from './memory.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i // also guards "new"
const MAX_TOOL_ROUNDS = 4
const MAX_MESSAGE_CHARS = 8000

// ---------- prompt ----------
const SYSTEM = 'You are a helpful assistant. Keep answers short and clear.'

function systemPrompt(user) {
  const lines = [`- Name: ${user.name}`]
  if (user.email) lines.push(`- Email: ${user.email}`)
  if (user.bio) lines.push(`- About them: ${user.bio}`)
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const facts = (user.facts ?? []).map((f) => `- [${f.id}] ${f.text}`)
  const procedures = (user.procedures ?? []).map((p) => `- [${p.id}] WHEN ${p.when} -> ${p.do}`)
  return `${SYSTEM}

You are talking to this user (from their saved profile):
${lines.join('\n')}

Long-term facts you remember about them (id in brackets; newest knowledge wins):
${facts.length ? facts.join('\n') : '(none yet)'}
Use these naturally when it helps (e.g. greet them by name, respect allergies and preferences). If they ask what you know about them, tell them.

HOW THIS USER WANTS YOU TO WORK (procedures you learned from them; id in brackets):
${procedures.length ? procedures.join('\n') : '(none yet)'}
Whenever a procedure's situation applies, follow it exactly, in any chat, without being reminded. Procedures
override the default style above. If the user says only a trigger word, start that routine straight away.

YOUR MEMORY WORKS IN THREE WAYS:
1. Automatic: after every message, lasting facts the user shares about themselves, and routines or standing rules
   for how you should work, are saved in the background and merged with what you already know. You can
   truthfully tell the user you will remember such things.
2. On request: when the user explicitly asks you to remember, correct or forget a FACT about themselves, call
   remember_fact (with replaces_id when it corrects an existing fact) or forget_fact. When they tell you HOW to
   work (a routine, "when I say X do Y", "from now on", format, length, tone or style rules, or a correction of
   how you answered that should apply next time), call save_procedure (with replaces_id to change an existing
   one) or forget_procedure. Changes are applied right after your reply and merged with what exists, so just
   confirm briefly. If something already covers it, point to it instead of saving it again.
3. Lessons: if you notice a better way to do something for this user (for example a tool only worked after you
   changed how you used it), call save_procedure with that lesson so you get it right first time next time.
Never claim you cannot remember things.

Today is ${today}.

You can only see THIS chat's messages directly. The user has other, earlier chats with you.
When they refer to something from before ("last time", "earlier", "remember when", "what did I tell you about...",
"what did we talk about yesterday"), or when you need a detail they may have mentioned in another chat,
call search_past_chats or list_recent_chats first, then answer from what you find.
Say which earlier chat the information came from. If nothing is found, say so; never invent past conversations.`
}

// ---------- tools ----------
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
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        'Record that the user EXPLICITLY asked you to remember or correct a fact about them. ' +
        'Write it as one short third-person sentence starting with "User". If it corrects an existing fact, pass that id as replaces_id. ' +
        'It is applied right after your reply and merged with existing facts.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact, e.g. "User likes Thai food"' },
          replaces_id: { type: 'string', description: 'Id of an existing fact this one corrects (optional)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_fact',
      description: 'Record that the user EXPLICITLY asked you to forget a remembered fact, or said it is no longer true.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id of the fact to forget (from the facts list)' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_procedure',
      description:
        'Record HOW the user wants you to work from now on: a routine they teach ("when I say standup, ask me..."), a standing rule ' +
        '("from now on...", "always...", "never..."), a format/length/style preference, or a lesson you learned about doing a task well. ' +
        'Pass replaces_id to change an existing procedure (write the complete new instructions). Applied right after your reply.',
      parameters: {
        type: 'object',
        properties: {
          when: { type: 'string', description: 'The situation or trigger, e.g. "the user says \'standup\'" or "explaining a technical concept"' },
          do: { type: 'string', description: 'Concrete step-by-step instructions to yourself, in order' },
          replaces_id: { type: 'string', description: 'Id of an existing procedure this one changes (optional)' },
          self_learned: { type: 'boolean', description: 'true if this is your own lesson from experience, not something the user asked for' },
        },
        required: ['when', 'do'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_procedure',
      description: 'Record that the user wants you to STOP following a procedure (by id from the procedures list).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id of the procedure to drop' } },
        required: ['id'],
      },
    },
  },
]
const MEMORY_TOOLS = new Set(['remember_fact', 'forget_fact', 'save_procedure', 'forget_procedure'])

async function runTool(name, args, ctx) {
  const clamp = (n, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+n) ? Math.round(+n) : d))
  if (name === 'remember_fact') {
    const text = String(args.text ?? '').trim().slice(0, 200)
    if (!text) return { error: 'text is required' }
    const replaces = ctx.facts.find((f) => f.id === args.replaces_id)
    ctx.memoryRequests.push({ action: 'remember', text, ...(replaces && { replaces_id: replaces.id, replaces_text: replaces.text }) })
    return { ok: true, status: 'recorded', note: 'Applied right after your reply, merged with existing facts. Confirm briefly.' }
  }
  if (name === 'forget_fact') {
    const fact = ctx.facts.find((f) => f.id === args.id)
    if (!fact) return { ok: false, error: 'No fact with that id. Use an id from the facts list.' }
    ctx.memoryRequests.push({ action: 'forget', id: fact.id, text: fact.text })
    return { ok: true, status: 'recorded', note: 'Applied right after your reply. Confirm briefly.' }
  }
  if (name === 'save_procedure') {
    const when = String(args.when ?? '').trim().slice(0, 150)
    const todo = String(args.do ?? '').trim().slice(0, 800)
    if (!when || !todo) return { error: 'when and do are required' }
    const replaces = ctx.procedures.find((p) => p.id === args.replaces_id)
    ctx.memoryRequests.push({
      action: 'learn_procedure', when, do: todo,
      ...(replaces && { replaces_id: replaces.id, replaces_when: replaces.when }),
      ...(args.self_learned === true && { self_learned: true }),
    })
    return { ok: true, status: 'recorded', note: 'Applied right after your reply, merged with existing procedures. Confirm briefly.' }
  }
  if (name === 'forget_procedure') {
    const proc = ctx.procedures.find((p) => p.id === args.id)
    if (!proc) return { ok: false, error: 'No procedure with that id. Use an id from the procedures list.' }
    ctx.memoryRequests.push({ action: 'forget_procedure', id: proc.id, when: proc.when })
    return { ok: true, status: 'recorded', note: 'Applied right after your reply. Confirm briefly.' }
  }
  if (name === 'search_past_chats') {
    const query = String(args.query ?? '').trim()
    if (!query) return { error: 'query is required' }
    const results = await db.searchPastChats(ctx.userId, ctx.chatId, query, clamp(args.limit, 1, 10, 6))
    const out = { query, count: results.length, results }
    // Procedural learning from experience: a retry worked after a search that found nothing.
    if (!results.length) ctx.failedQueries.push(query)
    else if (ctx.failedQueries.length && !ctx.procedures.some((p) => /search/i.test(p.when))) {
      out.lesson = `Your earlier search ${JSON.stringify(ctx.failedQueries)} found nothing, but ${JSON.stringify(query)} worked. ` +
        'Call save_procedure (self_learned: true) with when "searching past chats" and what to do differently, so the first search works next time.'
    }
    return out
  }
  if (name === 'list_recent_chats') {
    const days = clamp(args.days, 1, 90, 7)
    const chats = await db.listRecentChats(ctx.userId, ctx.chatId, days)
    return { days, count: chats.length, chats }
  }
  return { error: `Unknown tool ${name}` }
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
        found: (result.results ?? result.chats ?? []).map((r) => ({
          chat: r.chat ?? r.title,
          date: r.date ?? r.lastMessage,
          snippet: (r.message ?? r.firstMessage ?? '').slice(0, 140),
        })),
      })
    }
  }
}

// The single memory write for one message: facts and procedures together (see server/memory.js).
async function updateMemory({ user, chatId, text, previousReply, speculative, requests }) {
  let decision = speculative
  let tokens = speculative.tokens
  if (requests.length) {
    decision = await memory.decideMemory({ user, text, previousReply, requests })
    tokens += decision.tokens
    if (!decision.ok) {
      console.warn('[memory] decision with requests failed, applying requests literally:', decision.error)
      decision = {
        ok: true,
        ops: memory.requestsToOps(requests, user.facts ?? []),
        procOps: memory.requestsToProcOps(requests, user.procedures ?? []),
      }
    }
  } else if (!speculative.ok) {
    console.warn('[memory] background decision failed:', speculative.error)
  }
  // 'tool' = the user asked, 'lesson' = the agent's own lesson from experience, 'auto' = background decision
  const source = !requests.length ? 'auto' : requests.every((r) => r.self_learned) ? 'lesson' : 'tool'
  const empty = { changed: [], skipped: [] }
  const r = decision.ops.length || decision.procOps.length
    ? await db.applyMemoryOps(user.id, { facts: decision.ops, procedures: decision.procOps }, { chatId, via: source })
    : { facts: empty, procedures: empty }
  const skipped = [...r.facts.skipped, ...r.procedures.skipped]
  if (skipped.length) console.info('[memory] skipped ops:', skipped.map((s) => `${s.op}:${s.reason}`).join(', '))
  return {
    changes: [
      ...r.facts.changed.map((c) => ({ ...c, kind: 'fact', source })),
      ...r.procedures.changed.map((c) => ({ ...c, kind: 'procedure', source })),
    ],
    skipped: skipped.length,
    tokens,
  }
}

// ---------- http helpers ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1_000_000) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy() }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })) }
    })
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

  // DELETE /api/profile/facts/:id  -> forget one learned fact (from the profile screen)
  if (req.method === 'DELETE' && parts[0] === 'profile' && parts[1] === 'facts' && parts[2]) {
    return send(res, 200, await db.deleteFact(user.id, parts[2]))
  }

  // DELETE /api/profile/procedures/:id  -> stop following one learned procedure
  if (req.method === 'DELETE' && parts[0] === 'profile' && parts[1] === 'procedures' && parts[2]) {
    return send(res, 200, await db.deleteProcedure(user.id, parts[2]))
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
    if (text.length > MAX_MESSAGE_CHARS) return send(res, 400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` })

    const existing = UUID.test(parts[1]) ? await db.getChat(user.id, parts[1]) : null
    if (parts[1] !== 'new' && !existing) return send(res, 404, { error: 'Chat not found' })
    const chat = existing ?? { id: randomUUID(), title: text.slice(0, 50), messages: [] }

    // Profile + facts (system message) + previous history of THIS chat (from Postgres) + the new message.
    const prompt = [
      { role: 'system', content: systemPrompt(user) },
      ...chat.messages.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: text },
    ]

    const t = Date.now()
    const previousReply = chat.messages.findLast((m) => m.role === 'assistant')?.content
    const ctx = { userId: user.id, chatId: chat.id, facts: user.facts ?? [], procedures: user.procedures ?? [], memoryRequests: [], failedQueries: [] }
    // The reply and a speculative memory decision run at the same time, so learning adds no wait.
    const [out, speculative] = await Promise.all([
      answerWithTools({ model, messages: prompt, ctx }),
      memory.decideMemory({ user, text, previousReply }),
    ])
    if (out.status !== 200) return send(res, out.status, out.data) // nothing saved if the call failed

    const mem = await updateMemory({
      user, chatId: chat.id, text, previousReply, speculative, requests: ctx.memoryRequests,
    })

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
            proceduresInPrompt: user.procedures?.length ?? 0,
            memory: mem.changes,           // [{kind: 'fact'|'procedure', op, id, text | when+do, old?, source: 'tool'|'auto'}]
            memoryRequests: ctx.memoryRequests.length,
            memorySkipped: mem.skipped,
            memoryTokens: mem.tokens,
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
      handle(req, res).catch((e) => {
        if (!e.status) console.error('[api]', e)
        send(res, e.status ?? 500, { error: e.status ? e.message : 'Something went wrong on the server' })
      }))
  },
}
