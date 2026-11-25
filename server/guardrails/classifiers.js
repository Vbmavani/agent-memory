// TRAINED-MODEL GUARDRAILS (not LLMs): small neural classifiers that run locally in Node.
// They read text and return a probability, they cannot be "talked into" anything, and they cost nothing per call.
// Same library as server/embed.js (@huggingface/transformers); models download once and are cached.
//
//   injection: is this text trying to override the assistant's instructions?
//   toxicity:  is this text insulting, threatening or obscene?
import { pipeline } from '@huggingface/transformers'

export const INJECTION_MODEL = process.env.INJECTION_MODEL || 'Horizon-Labs/prompt-injection-guard-small'
export const TOXICITY_MODEL = process.env.TOXICITY_MODEL || 'Xenova/toxic-bert'

// Block at or above this probability. Measured on the injection model: attacks score 0.99+, harmless
// commands like "Refund ORD-1001 50" score ~0.6, so 0.9 separates them. Lower = catch more, block more real users.
export const THRESHOLDS = { injection: 0.9, toxicity: 0.8 }

const MODELS = {
  injection: { id: INJECTION_MODEL, opts: { dtype: 'q8' } },
  toxicity: { id: TOXICITY_MODEL, opts: { dtype: 'int8' } },
}
const loaded = {}
const state = { injection: 'idle', toxicity: 'idle' } // idle | loading | ready | error

function load(key) {
  if (!loaded[key]) {
    state[key] = 'loading'
    loaded[key] = pipeline('text-classification', MODELS[key].id, MODELS[key].opts)
      .then((p) => { state[key] = 'ready'; return p })
      .catch((e) => { state[key] = 'error'; loaded[key] = null; throw e })
  }
  return loaded[key]
}

export const classifierStatus = () => ({ ...state, models: { injection: INJECTION_MODEL, toxicity: TOXICITY_MODEL } })
/** Start loading both models in the background (called when the lab page opens). Errors show up in the status. */
export function warmup() { for (const k of Object.keys(MODELS)) load(k).catch(() => {}) }

// These models read ~512 word pieces, so an attack hidden deep in a long text would be missed.
// Scan it in windows and keep the worst score.
const WINDOW = 1500
const MAX_WINDOWS = 6
export function windows(text) {
  const out = []
  for (let i = 0; i < text.length && out.length < MAX_WINDOWS; i += WINDOW) out.push(text.slice(i, i + WINDOW))
  return out.length ? out : ['']
}

/** -> { score: probability of injection (0..1), label } */
export async function injectionScore(text) {
  const clf = await load('injection')
  let best = { score: 0, label: 'SAFE' }
  for (const w of windows(String(text))) {
    const res = await clf(w, { top_k: null })
    const p = res.find((r) => String(r.label).toUpperCase() === 'INJECTION')?.score ?? 0
    if (p > best.score) best = { score: p, label: 'INJECTION' }
  }
  return best
}

/** -> { score: probability of the worst toxicity label (0..1), label } */
export async function toxicityScore(text) {
  const clf = await load('toxicity')
  let best = { score: 0, label: 'none' }
  for (const w of windows(String(text))) {
    const res = await clf(w, { top_k: 1 })
    const top = Array.isArray(res) ? res[0] : res
    if (top.score > best.score) best = { score: top.score, label: top.label }
  }
  return best
}

// Bundled so tests (and the agent) can swap in fakes.
export const classifiers = { injectionScore, toxicityScore }
