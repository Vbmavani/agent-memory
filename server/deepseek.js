// Model API access. DeepSeek by default: the key is read per request from env DEEPSEEK_API_KEY, else
// from the macOS Keychain entry "deepseek-api-key", so it never lives in a file and the browser never
// sees it. Set LLM_PROVIDER=openrouter to send the same OpenAI-style calls to OpenRouter instead
// (key from env OPENROUTER_API_KEY or Keychain "openrouter-api-key"); used to run the memory eval on
// other models, e.g. LLM_PROVIDER=openrouter MEMORY_MODEL=openai/gpt-5-nano npm run eval:memory.
import { execFileSync } from 'node:child_process'

const PROVIDERS = {
  deepseek: { base: 'https://api.deepseek.com', env: 'DEEPSEEK_API_KEY', keychain: 'deepseek-api-key', name: 'DeepSeek' },
  openrouter: { base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', keychain: 'openrouter-api-key', name: 'OpenRouter' },
}
export const provider = () => PROVIDERS[process.env.LLM_PROVIDER] ?? PROVIDERS.deepseek
const TIMEOUT_MS = 60_000

function apiKey() {
  const p = provider()
  if (process.env[p.env]) return process.env[p.env]
  try {
    return execFileSync('security',
      ['find-generic-password', '-a', process.env.USER, '-s', p.keychain, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

// Returns { status, data }. Never throws for HTTP or network errors, so callers can degrade gracefully.
export async function deepseek(urlPath, init = {}) {
  const p = provider()
  const key = apiKey()
  if (!key) return { status: 500, data: { error: `No ${p.name} key found (env ${p.env} or Keychain "${p.keychain}").` } }
  try {
    const r = await fetch(p.base + urlPath, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return { status: r.status, data: { error: data?.error?.message || `${p.name} returned ${r.status}` } }
    return { status: 200, data }
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError'
    return { status: timedOut ? 504 : 502, data: { error: timedOut ? `${p.name} timed out` : `Could not reach ${p.name}: ${e.message}` } }
  }
}
