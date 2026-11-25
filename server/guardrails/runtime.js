// RUNTIME SAFETY BEYOND THE BUDGET: rate limit, circuit breaker, kill switch.
//   Budget (budget.js)     stops ONE request from running away.
//   Rate limiter           stops one session from sending too many requests.
//   Circuit breaker        stops hammering a model that is down (and stops paying for failing calls).
//   Kill switch            a human turns the whole agent off, instantly.

export class RateLimiter {
  constructor({ max = 5, windowMs = 30_000 } = {}) { this.max = max; this.windowMs = windowMs; this.hits = new Map() }
  check(key, now = Date.now()) {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return { ok: false, retryInMs: this.windowMs - (now - recent[0]) }
    }
    recent.push(now)
    this.hits.set(key, recent)
    return { ok: true }
  }
  reset() { this.hits.clear() }
}

export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 20_000 } = {}) {
    this.threshold = threshold; this.cooldownMs = cooldownMs; this.failures = 0; this.openedAt = 0
  }
  /** open = refuse calls; after the cooldown ONE trial call is allowed (half-open): if it fails the breaker re-opens. */
  canCall(now = Date.now()) {
    if (this.openedAt && now - this.openedAt < this.cooldownMs) return { ok: false, retryInMs: this.cooldownMs - (now - this.openedAt) }
    return { ok: true }
  }
  success() { this.failures = 0; this.openedAt = 0 }
  failure(now = Date.now()) { this.failures++; if (this.failures >= this.threshold) this.openedAt = now }
  reset() { this.failures = 0; this.openedAt = 0 }
}

/** Not a toggle on purpose: when a human flips it, it applies to every request. */
export const kill = {
  on: false,
  reason: '',
  set(on, reason = '') { this.on = !!on; this.reason = on ? reason : '' },
}

export const rateLimiter = new RateLimiter()
export const breaker = new CircuitBreaker()
