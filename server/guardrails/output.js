// OUTPUT GUARDRAILS: scan what the agent is about to show the user.

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g, // API-key style
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

export function checkOutput(text, { systemPrompt } = {}) {
  if (typeof text !== "string" || !text.trim())
    return { ok: false, reason: "empty response" };

  for (const re of SECRET_PATTERNS) {
    if (new RegExp(re.source).test(text))
      return { ok: false, reason: "response contains a secret/credential" };
  }

  // Crude system-prompt leak check: a long verbatim chunk of the prompt appears in the output.
  if (systemPrompt) {
    const chunk = systemPrompt.slice(0, 60);
    if (chunk.length >= 40 && text.includes(chunk))
      return { ok: false, reason: "response leaks the system prompt" };
  }
  return { ok: true, text };
}

// ---- FORMAT: the reply must be a plain message, not markup or a raw data dump ----
const MAX_REPLY_CHARS = 1500
export function checkFormat(text) {
  if (text.length > MAX_REPLY_CHARS) return { ok: false, reason: `reply too long (>${MAX_REPLY_CHARS} chars)` }
  if (/<\s*(script|iframe|object|embed)\b|\bon[a-z]+\s*=\s*["']|javascript:/i.test(text))
    return { ok: false, reason: 'reply contains active markup (script / event handler)' }
  if (/^\s*[[{]/.test(text)) return { ok: false, reason: 'reply is raw JSON, not a message' }
  return { ok: true }
}

// ---- GROUNDING: every specific number / amount / code in the reply must appear in what the agent was
// actually given (the user's message, the tool results, the system prompt). A code-based check that
// catches invented tracking numbers and prices. Real systems add an NLI model or an LLM judge for claims in prose.
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?/g
const NUMBER = /\b\d{3,}(?:\.\d+)?\b/g
const CODE = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{8,}\b/g
const norm = (s) => s.replace(/,/g, '').toLowerCase()

export function checkGrounding(text, corpus) {
  const hay = norm(String(corpus))
  const tokens = new Set([
    ...(text.match(MONEY) ?? []),
    ...(text.match(NUMBER) ?? []).filter((n) => !/^(19|20)\d\d$/.test(n)), // years are not claims
    ...(text.match(CODE) ?? []),
  ])
  const ungrounded = [...tokens].filter((t) => !hay.includes(norm(t).replace(/^\$\s?/, '')))
  return ungrounded.length
    ? { ok: false, reason: `reply states details that are not in the data: ${ungrounded.slice(0, 3).join(', ')}`, ungrounded }
    : { ok: true }
}
