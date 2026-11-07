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
//   5. RELEVANT PAST CONVERSATIONS: found automatically by meaning (embeddings or mem0, server/search.js)
import { randomUUID } from 'node:crypto'
import * as db from './db.js'
import { deepseek } from './deepseek.js'
import * as memory from './memory.js'
import * as search from './search.js'
import * as graph from './graph.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i // also guards "new"
const MAX_TOOL_ROUNDS = 4
const MAX_MESSAGE_CHARS = 8000

// ---------- prompt ----------
const SYSTEM = 'You are a helpful assistant. Keep answers short and clear.'

function recalledSection(recalled) {
  if (!recalled?.length) return ''
  const items = recalled.map((r) =>
    `- From the chat "${r.chat}" (${String(r.date).slice(0, 10)}, similarity ${r.similarity}):\n` +
    (r.before ? `    before: ${r.before}\n` : '') +
    `    ${r.role}: ${r.message}` +
    (r.after ? `\n    after: ${r.after}` : ''))
  return `

RELEVANT PAST CONVERSATIONS (found automatically because they are close in meaning to the user's new message;
they may or may not matter, so use them only if they actually help, and say which chat you are using):
${items.join('\n')}`
}

function graphSection(user) {
  if (!graph.graphOn()) return ''
  const n = (user.edges ?? []).filter((e) => !e.until).length
  return `GRAPH MEMORY: besides facts, you keep a graph of how the people, places and things in the user's life are connected
(for example You -managed_by-> Ana -lives_in-> Paris). It has ${n} connection${n === 1 ? '' : 's'}. For questions that follow connections
("where does my manager live?", "who is connected to X?", "what do I know about Ana?") call explore_graph with the starting
name ("You" for the user) and enough hops, then answer from the connections it returns. The graph is updated automatically.

`
}

function systemPrompt(user, recalled) {
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

${graphSection(user)}You can only see THIS chat's messages directly. The user has other, earlier chats with you.
When they refer to something from before ("last time", "earlier", "remember when", "what did I tell you about...",
"what did we talk about yesterday"), or when you need a detail they may have mentioned in another chat,
call search_past_chats or list_recent_chats first, then answer from what you find.
Say which earlier chat the information came from. If nothing is found, say so; never invent past conversations.${recalledSection(recalled)}`
}

// ---------- compare mode: the same question answered by vector memory and by graph memory ----------
// Read-only: nothing is saved, no memory tools exist. Each side may use ONLY its own kind of memory.
function comparePrompt(user, side, recalled) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const facts = (user.facts ?? []).map((f) => `- ${f.text}`)
  const base = `You answer questions about the user (${user.name}) using ONLY your memory. Answer in one or two short sentences. ` +
    `If your memory does not contain the answer, say you don't know. Never guess. Today is ${today}.` +
    (facts.length ? `\n\nSaved facts about the user:\n${facts.join('\n')}` : '')
  if (side === 'graph') {
    const n = (user.edges ?? []).filter((e) => !e.until).length
    return base + `\n\nYour memory is a GRAPH of connections between the people, places and things in the user's life ` +
      `(for example You -managed_by-> Ana -lives_in-> Paris). It has ${n} connection${n === 1 ? '' : 's'}. Call explore_graph with a starting ` +
      `name ("You" for the user) and enough hops to follow the connections, then answer from what it returns. Say which connections you followed.`
  }
  return base + `\n\nYour memory is the user's earlier chats with you. Look things up with search_past_chats (it searches by meaning, so ` +
    `describe what you want in plain words) or list_recent_chats, then answer from what you find. Say which chat it came from.` + recalledSection(recalled)
}

// ---------- tools ----------
// The search tool's description depends on SEARCH_MODE (server/search.js): step 1 matches words,
// step 2 matches meaning, so the model should write its queries differently.
function searchToolDescription(mode) {
  const base = "Search the user's earlier chats with you (not the current chat). " +
    'Returns matching messages with the chat title, date, and the messages around them. '
  if (mode === 'mem0') {
    return "Search the memories you have about the user from earlier chats. Each result is a short memory " +
      '(e.g. "User\'s cat is named Pixel") with the chat it came from and a score; higher is a better match. ' +
      'Describe what you are looking for in plain words, e.g. "what is my pet called" or "the trip I was planning".'
  }
  if (mode === 'keyword') {
    return base + 'This is a keyword search: use short keyword queries, e.g. "cat name", "Kyoto trip", "allergy". Try another wording if nothing is found.'
  }
  return base + (mode === 'meaning' ? 'It searches by meaning, so ' : 'It searches by meaning and by keywords, so ') +
    'describe what you are looking for in plain words, e.g. "what is my pet called" or "the trip I was planning". ' +
    'Each result has a similarity (0-1) and matchedBy (meaning / words / both). Low similarity means a weak match.'
}

const toolsFor = (mode) => [...(graph.graphOn() ? [GRAPH_TOOL] : []),
  {
    type: 'function',
    function: {
      name: 'search_past_chats',
      description: searchToolDescription(mode),
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
// Read-only graph lookup (see server/graph.js and db.walkGraph).
const GRAPH_TOOL = {
  type: 'function',
  function: {
    name: 'explore_graph',
    description:
      "Walk the graph of connections in the user's life, starting at one person, place or thing. Returns every connection within " +
      'N hops, e.g. entity "You", 2 hops: You -managed_by-> Ana (hop 1), Ana -lives_in-> Paris (hop 2). Use it for questions that join ' +
      'several facts ("which city does my manager live in?"). Use "You" for the user.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Starting name, e.g. "You", "Ana", "Acme"' },
        hops: { type: 'integer', description: 'How many connections to follow, 1-3 (default 2)' },
      },
      required: ['entity'],
    },
  },
}
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
    const results = await search.searchPastChats(ctx.userId, ctx.chatId, query, clamp(args.limit, 1, 10, 6), ctx.searchMode)
    const out = { query, mode: ctx.searchMode, count: results.length, results }
    // Procedural learning from experience: a retry worked after a search that found nothing.
    if (!results.length) ctx.failedQueries.push(query)
    else if (ctx.failedQueries.length && !ctx.procedures.some((p) => /search/i.test(p.when))) {
      out.lesson = `Your earlier search ${JSON.stringify(ctx.failedQueries)} found nothing, but ${JSON.stringify(query)} worked. ` +
        'Call save_procedure (self_learned: true) with when "searching past chats" and what to do differently, so the first search works next time.'
    }
    return out
  }
  if (name === 'explore_graph') {
    const key = graph.nodeKey(args.entity)
    if (!key) return { error: 'entity is required' }
    const hops = clamp(args.hops, 1, 3, 2)
    const edges = await db.walkGraph(ctx.userId, key, hops)
    return {
      entity: args.entity, hops, count: edges.length,
      note: edges.length ? 'Connections are listed by hop; follow them in both directions.' : 'Nothing is connected to that name in the graph.',
      results: edges.map((e) => ({
        chat: `${e.from} —${e.rel}→ ${e.to}`, date: e.since, message: `hop ${e.hop}`, matchedBy: 'graph', hop: e.hop,
      })),
    }
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
      body: JSON.stringify({ model, messages: convo, max_tokens: 1000, ...(allowTools && { tools: toolsFor(ctx.searchMode).filter((t) => !ctx.toolNames || ctx.toolNames.includes(t.function.name)) }) }),
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
        mode: result.mode,
        found: (result.results ?? result.chats ?? []).map((r) => ({
          chat: r.chat ?? r.title,
          date: r.date ?? r.lastMessage,
          snippet: (r.message ?? r.firstMessage ?? '').slice(0, 140),
          ...(r.matchedBy && { matchedBy: r.matchedBy }),
          ...(r.similarity != null && { similarity: r.similarity }),
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

// ---------- who is logged in ----------
const USER_COOKIE = 'am_user'
function userIdFromCookie(req) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${USER_COOKIE}=([^;]+)`))
  return m && UUID.test(m[1]) ? m[1] : null
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean) // e.g. ['chats', '<id>', 'messages']

  // POST /api/login {name}  -> log in as that username (created if new); remembered in a cookie.
  // A local learning app: there are no passwords, anyone who can open the app can switch users.
  if (req.method === 'POST' && parts[0] === 'login') {
    const name = String((await readJson(req)).name ?? '').trim().replace(/\s+/g, ' ')
    if (!name) return send(res, 400, { error: 'Type a username' })
    if (name.length > 40) return send(res, 400, { error: 'Usernames are 40 characters at most' })
    const u = await db.findOrCreateUser(name)
    res.setHeader('Set-Cookie', `${USER_COOKIE}=${u.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
    return send(res, 200, u)
  }

  const user = await db.currentUser(userIdFromCookie(req))

  // GET /api/users  -> everyone you can switch to, and who is logged in now
  if (req.method === 'GET' && parts[0] === 'users') {
    return send(res, 200, { users: await db.listUsers(), current: user.id })
  }

  // GET /api/models
  if (req.method === 'GET' && parts[0] === 'models') {
    const { status, data } = await deepseek('/models')
    return send(res, status, status === 200 ? { models: data.data.map((m) => m.id) } : data)
  }

  // GET /api/graph -> every connection (true and closed); GET /api/graph/walk?entity=&hops=&history=1 -> a recursive walk
  if (parts[0] === 'graph' && !parts[1] && req.method === 'GET') return send(res, 200, { edges: user.edges ?? [] })
  if (parts[0] === 'graph' && parts[1] === 'walk' && req.method === 'GET') {
    const entity = graph.nodeKey(url.searchParams.get('entity') || 'you') || 'you'
    const hops = Math.min(3, Math.max(1, Number(url.searchParams.get('hops')) || 2))
    const history = url.searchParams.get('history') === '1'
    return send(res, 200, { entity, hops, edges: await db.walkGraph(user.id, entity, hops, { history }), sql: db.WALK_SQL })
  }
  // POST /api/graph/example -> add a small example graph (no model call), to try the lab without chatting first
  if (parts[0] === 'graph' && parts[1] === 'example' && req.method === 'POST') {
    await db.applyGraphTriples(user.id, graph.EXAMPLE_TRIPLES, { chatId: null })
    return send(res, 200, { edges: (await db.currentUser(user.id)).edges })
  }
  // DELETE /api/graph/edges/:id
  if (parts[0] === 'graph' && parts[1] === 'edges' && parts[2] && req.method === 'DELETE') {
    return send(res, 200, { edges: (await db.deleteEdge(user.id, parts[2])).edges })
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
        if (e.code === '23505') return send(res, 409, { error: 'That name or email is already used by another user' })
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

  // POST /api/compare {model, content, withFacts} -> { vector, graph }: two answers in parallel, nothing saved
  if (req.method === 'POST' && parts[0] === 'compare') {
    const { model, content, withFacts } = await readJson(req)
    const text = String(content || '').trim()
    if (!text) return send(res, 400, { error: 'Empty message' })
    if (text.length > MAX_MESSAGE_CHARS) return send(res, 400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` })
    const run = async (side) => {
      const t = Date.now()
      const recalled = side === 'vector' ? await search.recallForPrompt(user.id, null, text, 3, 'meaning') : []
      const ctx = {
        searchMode: 'meaning', userId: user.id, chatId: null, facts: [], procedures: [], memoryRequests: [], failedQueries: [],
        toolNames: side === 'vector' ? ['search_past_chats', 'list_recent_chats'] : ['explore_graph'],
      }
      const u = { ...user, facts: withFacts ? user.facts ?? [] : [] }
      const out = await answerWithTools({
        model, ctx,
        messages: [{ role: 'system', content: comparePrompt(u, side, recalled) }, { role: 'user', content: text }],
      }).catch((e) => ({ status: 500, data: { error: String(e.message || e) } }))
      if (out.status !== 200) return { error: out.data?.error ?? `Model call failed (${out.status})` }
      return {
        answer: out.reply, ms: Date.now() - t, promptTokens: out.usage.prompt, outTokens: out.usage.out, modelCalls: out.rounds,
        toolCalls: [
          ...(recalled.length ? [{
            name: 'auto_recall', args: {}, count: recalled.length, mode: 'meaning',
            found: recalled.map((r) => ({ chat: r.chat, date: r.date, snippet: r.message.slice(0, 140), matchedBy: r.matchedBy, similarity: r.similarity })),
          }] : []),
          ...out.toolCalls,
        ],
      }
    }
    const [vector, graphSide] = await Promise.all([run('vector'), run('graph')])
    return send(res, 200, { vector, graph: graphSide })
  }

  // POST /api/chats/:id/messages  (id "new" starts a chat)  body: { model, content }
  if (req.method === 'POST' && parts[0] === 'chats' && parts[2] === 'messages') {
    const body = await readJson(req)
    const { model, content } = body
    const searchMode = search.searchMode(body.searchMode) // the chat UI's Search menu, else SEARCH_MODE
    const text = String(content || '').trim()
    if (!text) return send(res, 400, { error: 'Empty message' })
    if (text.length > MAX_MESSAGE_CHARS) return send(res, 400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters)` })

    const existing = UUID.test(parts[1]) ? await db.getChat(user.id, parts[1]) : null
    if (parts[1] !== 'new' && !existing) return send(res, 404, { error: 'Chat not found' })
    const chat = existing ?? { id: randomUUID(), title: text.slice(0, 50), messages: [] }

    // Past chats close in meaning to this message, added to the prompt without the model asking.
    const recalled = await search.recallForPrompt(user.id, chat.id, text, 3, searchMode)

    // Profile + facts (system message) + previous history of THIS chat (from Postgres) + the new message.
    const prompt = [
      { role: 'system', content: systemPrompt(user, recalled) },
      ...chat.messages.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: text },
    ]

    const t = Date.now()
    const previousReply = chat.messages.findLast((m) => m.role === 'assistant')?.content
    const ctx = { searchMode, userId: user.id, chatId: chat.id, facts: user.facts ?? [], procedures: user.procedures ?? [], memoryRequests: [], failedQueries: [] }
    // The reply and a speculative memory decision run at the same time, so learning adds no wait.
    const [out, speculative, extracted] = await Promise.all([
      answerWithTools({ model, messages: prompt, ctx }),
      memory.decideMemory({ user, text, previousReply }),
      graph.graphOn() ? graph.extractTriples({ text, previousReply, existing: user.edges ?? [] }) : null,
    ])
    if (out.status !== 200) return send(res, out.status, out.data) // nothing saved if the call failed

    const mem = await updateMemory({
      user, chatId: chat.id, text, previousReply, speculative, requests: ctx.memoryRequests,
    })

    // Graph memory: connections found in the message (people, places, things), added in one locked write.
    let graphChanges = []
    if (extracted?.ok) {
      graphChanges = (await db.applyGraphTriples(user.id, extracted.triples, { chatId: chat.id }).catch((e) => { console.warn('[graph] not saved:', e.message); return [] }))
        .map((c) => ({ ...c, kind: 'graph', source: 'auto' }))
    } else if (extracted) console.warn('[graph] extraction failed:', extracted.error)

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
            searchMode,
            toolCalls: [
              ...(recalled.length ? [{
                name: 'auto_recall', args: {}, count: recalled.length, mode: searchMode,
                found: recalled.map((r) => ({ chat: r.chat, date: r.date, snippet: r.message.slice(0, 140), matchedBy: r.matchedBy, similarity: r.similarity })),
              }] : []),
              ...out.toolCalls,
            ],
            factsInPrompt: user.facts?.length ?? 0,
            proceduresInPrompt: user.procedures?.length ?? 0,
            memory: [...mem.changes, ...graphChanges],           // [{kind: 'fact'|'procedure', op, id, text | when+do, old?, source: 'tool'|'auto'}]
            memoryRequests: ctx.memoryRequests.length,
            memorySkipped: mem.skipped,
            memoryTokens: mem.tokens + (extracted?.tokens ?? 0),
            edgesInGraph: (user.edges ?? []).filter((e) => !e.until).length,
          },
        },
      ],
    })
    // Keep this chat's embedding current for future searches (in the background, after replying).
    search.refreshChatEmbedding(user.id, saved).catch((e) => console.warn('[embed] chat not embedded:', e.message))
    // Step 3: let mem0 learn from this turn too (it extracts memories on its side, a few seconds later).
    if (search.mem0Enabled()) {
      search.rememberInMem0(user.id, chat.id, [{ role: 'user', content: text, at: now }, { role: 'assistant', content: out.reply }])
        .catch((e) => console.warn('[mem0] turn not sent:', e.message))
    }
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
