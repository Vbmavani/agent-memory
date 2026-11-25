// API for the Guardrails lab (a separate Vite plugin, so it needs no database and does not touch server/api.js).
//
//   GET  /api/guardrails/status            -> { live }  is a DeepSeek key available? (otherwise only the mock model works)
//   POST /api/guardrails/chat              -> Server-Sent Events: `log` (one per guardrail decision), `approval`
//                                             (a human must say yes/no), then `final` with the answer
//   POST /api/guardrails/approve {id, ok}  -> the human's answer to an `approval` event
//
// The browser never sees the key. Every request is a single turn with no saved history.
import { randomUUID } from 'node:crypto'
import { runAgent } from './agent.js'
import { mockChat } from './mock.js'
import { deepseek } from '../deepseek.js'

const MAX_MESSAGE_CHARS = 8000
const APPROVAL_TIMEOUT_MS = 60_000
const GUARDS = ['input', 'tool', 'output', 'budget']

const pending = new Map() // approval id -> resolve(boolean)

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 100_000) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy() }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })) }
    })
  })
}
const sendJson = (res, status, data) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

let liveCache // cache "is there a key" for 30 s so the status call stays cheap
async function liveAvailable() {
  if (liveCache && Date.now() - liveCache.at < 30_000) return liveCache.ok
  const { status } = await deepseek('/models')
  liveCache = { ok: status === 200, at: Date.now() }
  return liveCache.ok
}

async function chat(req, res) {
  const body = await readJson(req)
  const message = String(body.message ?? '')
  if (!message.trim()) return sendJson(res, 400, { error: 'Type a message' })
  if (message.length > MAX_MESSAGE_CHARS) return sendJson(res, 400, { error: `Messages are ${MAX_MESSAGE_CHARS} characters at most` })

  const mock = body.mock !== false // the mock model is the default: free, instant and predictable
  if (!mock && !(await liveAvailable())) {
    return sendJson(res, 400, { error: 'No DeepSeek key found (env DEEPSEEK_API_KEY or Keychain "deepseek-api-key"). Use the mock model.' })
  }
  const guards = Object.fromEntries(GUARDS.map((g) => [g, body.guards?.[g] !== false]))

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  const emit = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }

  const mine = new Set()
  res.on('close', () => { for (const id of mine) { pending.get(id)?.(false); pending.delete(id) } }) // tab closed: deny

  const approve = (name, args) =>
    new Promise((resolve) => {
      const id = randomUUID()
      mine.add(id)
      const timer = setTimeout(() => { pending.delete(id); resolve(false) }, APPROVAL_TIMEOUT_MS)
      pending.set(id, (ok) => { clearTimeout(timer); resolve(ok) })
      emit('approval', { id, name, args, seconds: APPROVAL_TIMEOUT_MS / 1000 })
    })

  const started = Date.now()
  const result = await runAgent(message, {
    chat: mock ? mockChat : undefined,
    approve,
    guards,
    log: (e) => emit('log', { ...e, ms: Date.now() - started }),
  })
  emit('final', { ...result, ms: Date.now() - started })
  res.end()
}

async function handle(req, res) {
  const path = new URL(req.url, 'http://x').pathname
  if (req.method === 'GET' && path === '/status') return sendJson(res, 200, { live: await liveAvailable() })
  if (req.method === 'POST' && path === '/chat') return chat(req, res)
  if (req.method === 'POST' && path === '/approve') {
    const { id, ok } = await readJson(req)
    const resolve = pending.get(id)
    if (!resolve) return sendJson(res, 404, { error: 'That approval expired' })
    pending.delete(id)
    resolve(ok === true)
    return sendJson(res, 200, { ok: true })
  }
  return sendJson(res, 404, { error: 'Not found' })
}

export const guardrailsApi = {
  name: 'guardrails-api',
  configureServer(server) {
    server.middlewares.use('/api/guardrails', (req, res) =>
      handle(req, res).catch((e) => {
        if (!e.status) console.error('[guardrails]', e)
        if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.status ? e.message : 'Something went wrong on the server' })
        else res.end()
      }))
  },
}
