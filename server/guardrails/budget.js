// RUNTIME GUARDRAILS: stop runaway loops and runaway cost.

export class Budget {
  constructor({ maxSteps = 6, maxTokens = 20000, maxMs = 60000 } = {}) {
    this.maxSteps = maxSteps;
    this.maxTokens = maxTokens;
    this.maxMs = maxMs;
    this.steps = 0;
    this.tokens = 0;
    this.start = Date.now();
    this.seenCalls = new Map();
  }

  addUsage(usage) {
    this.tokens += usage?.total_tokens ?? 0;
  }

  /** Throws a descriptive error when any limit is hit. Call once per loop iteration. */
  tick() {
    this.steps++;
    if (this.steps > this.maxSteps) throw new Error(`step limit (${this.maxSteps}) exceeded`);
    if (this.tokens > this.maxTokens) throw new Error(`token budget (${this.maxTokens}) exceeded`);
    if (Date.now() - this.start > this.maxMs) throw new Error(`time limit (${this.maxMs}ms) exceeded`);
  }

  /** Detect the agent repeating the exact same tool call (a typical loop). */
  recordCall(name, args) {
    const key = name + JSON.stringify(args);
    const n = (this.seenCalls.get(key) ?? 0) + 1;
    this.seenCalls.set(key, n);
    if (n > 2) throw new Error(`loop detected: ${name} called ${n}x with identical arguments`);
  }
}
