// OBSERVABILITY: an audit trail of every request and simple alert rules on top of it.
// Entries are kept in memory (last 200) and appended to data/guardrails-audit.jsonl (data/ is git-ignored).
// Messages are stored AFTER PII redaction, so the log itself does not become a leak.
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { redactPII } from './input.js'

const HIGH_RISK = new Set(['issue_refund'])

export class Audit {
  constructor({ file = 'data/guardrails-audit.jsonl', keep = 200 } = {}) {
    this.file = file; this.keep = keep
    this.entries = []; this.alerts = []; this.lastAlert = new Map()
  }

  /** Record one finished request. Returns the alerts it triggered (also stored). */
  async record({ session, message, guards, trace, final, role }) {
    const blocked = final?.blocked ?? null
    const off = Object.entries(guards ?? {}).filter(([, v]) => !v).map(([k]) => k)
    const entry = {
      ts: new Date().toISOString(),
      session: String(session).slice(0, 8),
      role,
      message: redactPII(String(message)).text.slice(0, 200),
      guardsOff: off,
      outcome: blocked ? 'blocked' : 'answered',
      reason: blocked,
      events: trace.map((e) => `${e.stage}${e.blocked ? ':blocked' : ''}${e.unavailable ? ':unavailable' : ''}`),
      ms: final?.ms ?? null,
    }
    this.entries.push(entry)
    if (this.entries.length > this.keep) this.entries.shift()
    try {
      await mkdir(path.dirname(this.file), { recursive: true })
      await appendFile(this.file, JSON.stringify(entry) + '\n')
    } catch { /* logging must never break the request */ }

    const fired = []
    const alert = (rule, severity, text) => {
      const a = { ts: entry.ts, rule, severity, message: text }
      this.alerts.push(a); if (this.alerts.length > this.keep) this.alerts.shift(); fired.push(a)
    }

    // Rule 1: probing. Three blocked requests from one session within a minute.
    if (blocked) {
      const since = Date.now() - 60_000
      const n = this.entries.filter((e) => e.session === entry.session && e.outcome === 'blocked' && Date.parse(e.ts) >= since).length
      const last = this.lastAlert.get(entry.session) ?? 0
      if (n >= 3 && Date.now() - last > 60_000) {
        this.lastAlert.set(entry.session, Date.now())
        alert('repeated-blocks', 'warning', `${n} blocked requests from session ${entry.session} in 60 s (possible probing)`)
      }
    }
    // Rule 2: a high-risk tool ran while the tool guardrail was off.
    for (const e of trace) {
      if (e.stage === 'tool' && e.reason === 'tool guardrail OFF' && HIGH_RISK.has(e.name))
        alert('unguarded-high-risk', 'critical', `${e.name} ran with NO gate (session ${entry.session})`)
    }
    // Rule 3: a classifier was unavailable, so a check was silently skipped.
    if (trace.some((e) => e.unavailable))
      alert('check-skipped', 'warning', 'a guardrail model was unavailable and its check was skipped')
    return fired
  }

  /** For events that do not come from a request (kill switch, breaker). */
  systemAlert(rule, severity, message) {
    const a = { ts: new Date().toISOString(), rule, severity, message }
    this.alerts.push(a); if (this.alerts.length > this.keep) this.alerts.shift()
    return a
  }

  recent(n = 30) { return this.entries.slice(-n).reverse() }
  recentAlerts(n = 20) { return this.alerts.slice(-n).reverse() }
  clear() { this.entries = []; this.alerts = []; this.lastAlert.clear() }
}

export const audit = new Audit()
