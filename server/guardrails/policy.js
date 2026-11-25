// POLICY ENGINE + LEAST PRIVILEGE.
// The rules are DATA (the ROLES object), not if-statements scattered through the code. A tiny interpreter
// (evaluatePolicy) applies them. Production systems use the same idea with OPA or Cedar: policy lives in
// config, can be reviewed and versioned, and changes without touching the agent.
//
// Least privilege: a "customer" session can only look up orders, even if the model is tricked into asking for more.

export const ROLES = {
  customer: {
    label: 'Customer',
    allow: [{ tool: 'get_order' }],
  },
  support: {
    label: 'Support agent',
    allow: [
      { tool: 'get_order' },
      { tool: 'run_sql' },
      {
        tool: 'issue_refund',
        where: { amount: { max: 500 } }, // per call
        sessionLimit: { field: 'amount', max: 600 }, // cumulative: ten small refunds are still stopped
      },
    ],
  },
}

/** Remembers how much each session has used (in memory; a real system would use a database). */
export class UsageTracker {
  constructor() { this.totals = new Map() }
  key(session, tool, field) { return `${session}|${tool}|${field}` }
  get(session, tool, field) { return this.totals.get(this.key(session, tool, field)) ?? 0 }
  add(session, tool, field, n) { this.totals.set(this.key(session, tool, field), this.get(session, tool, field) + n) }
  reset(session) { for (const k of [...this.totals.keys()]) if (k.startsWith(session + '|')) this.totals.delete(k) }
}
export const usage = new UsageTracker()

/** -> { allow, reason? } */
export function evaluatePolicy({ role, tool, args, usage: tracker = usage, session = 'anon' }) {
  const r = ROLES[role]
  if (!r) return { allow: false, reason: `unknown role "${role}"` }
  const rule = r.allow.find((x) => x.tool === tool)
  if (!rule) return { allow: false, reason: `role "${role}" may not use ${tool}` }

  for (const [field, c] of Object.entries(rule.where ?? {})) {
    const v = args?.[field]
    if (c.max != null && !(Number(v) <= c.max)) return { allow: false, reason: `${field} must be at most ${c.max} for role "${role}"` }
    if (c.min != null && !(Number(v) >= c.min)) return { allow: false, reason: `${field} must be at least ${c.min}` }
  }
  if (rule.sessionLimit) {
    const { field, max } = rule.sessionLimit
    const used = tracker.get(session, tool, field)
    if (used + Number(args?.[field]) > max)
      return { allow: false, reason: `session limit: ${used} already used of ${max} allowed in total for ${tool}` }
  }
  return { allow: true }
}

/** Call after a tool actually ran, so cumulative limits count real usage only. */
export function recordUsage({ role, tool, args, usage: tracker = usage, session = 'anon' }) {
  const rule = ROLES[role]?.allow.find((x) => x.tool === tool)
  if (rule?.sessionLimit) tracker.add(session, tool, rule.sessionLimit.field, Number(args?.[rule.sessionLimit.field]) || 0)
}
