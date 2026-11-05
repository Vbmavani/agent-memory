// DeepSeek API access. The key is read per request from env DEEPSEEK_API_KEY, else from the
// macOS Keychain entry "deepseek-api-key", so it never lives in a file and the browser never sees it.
import { execFileSync } from 'node:child_process'

const BASE = 'https://api.deepseek.com'
const TIMEOUT_MS = 60_000

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    return execFileSync('security',
      ['find-generic-password', '-a', process.env.USER, '-s', 'deepseek-api-key', '-w'],
      { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Returns { status, data }. Never throws for HTTP or network errors, so callers can degrade gracefully.
export async function deepseek(urlPath, init = {}) {
  const key = apiKey()
  if (!key) return { status: 500, data: { error: 'No DeepSeek key found (env DEEPSEEK_API_KEY or Keychain "deepseek-api-key").' } }
  try {
    const r = await fetch(BASE + urlPath, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return { status: r.status, data: { error: data?.error?.message || `DeepSeek returned ${r.status}` } }
    return { status: 200, data }
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError'
    return { status: timedOut ? 504 : 502, data: { error: timedOut ? 'DeepSeek timed out' : `Could not reach DeepSeek: ${e.message}` } }
  }
}
