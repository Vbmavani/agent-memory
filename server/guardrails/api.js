// API for the Guardrails lab (a separate Vite plugin, so it needs no database and does not touch server/api.js).
//
//   GET  /api/guardrails/status            -> { live, models, killed, roles }  (also starts loading the local models)
//   POST /api/guardrails/chat              -> Server-Sent Events: `log` (one per guardrail decision), `approval`
//                                             (a human must say yes/no), `alert`, then `final` with the answer
//   POST /api/guardrails/approve {id, ok}  -> the human's answer to an `approval` event
//   POST /api/guardrails/kill {on}         -> the kill switch: while ON, every request is refused
//   GET  /api/guardrails/audit             -> recent requests and alerts (the audit trail)
//   POST /api/guardrails/reset {sessionId} -> forget this session's cumulative usage and rate-limit / breaker state
//
// The browser never sees the key. Every request is a single turn with no saved history.
import { randomUUID } from 'node:crypto'
import { runAgent, GUARD_KEYS } from './agent.js'
import { mockChat, mockAsk } from './mock.js'
import { deepseek } from '../deepseek.js'
import { classifierStatus, warmup } from './classifiers.js'
import { ROLES, usage } from './policy.js'
import { kill, rateLimiter, breaker } from './runtime.js'
import { audit } from './audit.js'

const MAX_MESSAGE_CHARS = 8000
const APPROVAL_TIMEOUT_MS = 60_000

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
  const guards = Object.fromEntries(GUARD_KEYS.map((g) => [g, body.guards?.[g] !== false]))
  const role = ROLES[body.role] ? body.role : 'support'
  const sessionId = String(body.sessionId ?? 'anon').slice(0, 64)

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
  const trace = []
  const wasOpen = breaker.openedAt > 0
  const result = await runAgent(message, {
    chat: mock ? mockChat : undefined,
    ask: mock ? mockAsk : undefined,
    approve,
    guards,
    role,
    sessionId,
    log: (e) => { const ev = { ...e, ms: Date.now() - started }; trace.push(ev); emit('log', ev) },
  })
  const final = { ...result, ms: Date.now() - started }
  emit('final', final)

  // Observability: audit trail + alert rules. Alerts reach the page as `alert` events.
  const alerts = await audit.record({ session: sessionId, message, guards, trace, final, role })
  if (!wasOpen && breaker.openedAt > 0) alerts.push(audit.systemAlert('circuit-open', 'warning', 'circuit breaker opened: the model keeps failing'))
  for (const a of alerts) emit('alert', a)
  res.end()
}

async function handle(req, res) {
  const path = new URL(req.url, 'http://x').pathname
  if (req.method === 'GET' && path === '/status') {
    warmup() // first visit starts downloading / loading the local models in the background
    return sendJson(res, 200, {
      live: await liveAvailable(),
      models: classifierStatus(),
      killed: kill.on,
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
    })
  }
  if (req.method === 'GET' && path === '/audit') return sendJson(res, 200, { entries: audit.recent(30), alerts: audit.recentAlerts(20) })
  if (req.method === 'POST' && path === '/chat') return chat(req, res)
  if (req.method === 'POST' && path === '/kill') {
    const { on } = await readJson(req)
    kill.set(on === true, 'turned on by a human in the lab')
    audit.systemAlert('kill-switch', on === true ? 'critical' : 'info', on === true ? 'KILL SWITCH turned ON: all requests are refused' : 'kill switch turned off')
    return sendJson(res, 200, { killed: kill.on })
  }
  if (req.method === 'POST' && path === '/reset') {
    const { sessionId } = await readJson(req)
    usage.reset(String(sessionId ?? 'anon'))
    rateLimiter.reset(); breaker.reset(); audit.clear()
    return sendJson(res, 200, { ok: true })
  }
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
