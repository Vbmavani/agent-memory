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
