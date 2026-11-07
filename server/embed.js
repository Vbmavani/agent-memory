// Embeddings: text -> 384 numbers that describe its meaning.
// Same idea as the vectors lab (/vectors.html), with 384 numbers instead of 3, learned by a real model.
//
// The model is all-MiniLM-L6-v2, a small sentence-embedding model (~23 MB) that runs right here in
// Node (no API key, nothing leaves your machine). It is downloaded once on first use and cached.
// Every vector is normalized to length 1, so cosine similarity is just the dot product.
import { pipeline } from '@huggingface/transformers'

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const DIMENSIONS = 384
const MAX_CHARS = 1000 // the model reads ~256 word pieces; longer text is cut anyway

let extractor
function model() {
  extractor ??= pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' })
    .catch((e) => { extractor = null; throw e })
  return extractor
}

// Several texts -> several vectors (one model call). Results are cached by text.
const cache = new Map()
const CACHE_MAX = 2000
export async function embedMany(texts) {
  const clean = texts.map((t) => String(t ?? '').slice(0, MAX_CHARS))
  const missing = [...new Set(clean.filter((t) => !cache.has(t)))]
  if (missing.length) {
    const out = await (await model())(missing, { pooling: 'mean', normalize: true })
    out.tolist().forEach((v, i) => {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value) // drop the oldest
      cache.set(missing[i], v)
    })
  }
  return clean.map((t) => cache.get(t))
}

export async function embed(text) {
  return (await embedMany([text]))[0]
}

// ---------- vector math (pure, tested in test/embed.test.js) ----------

// Both vectors have length 1, so the dot product is the cosine: 1 = same meaning, ~0 = unrelated.
export function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function normalize(v) {
  const len = Math.hypot(...v)
  return len ? v.map((x) => x / len) : v
}

// One point for a whole chat: the average of its messages' points (like "a sentence = the average
// of its words" in the explainer), scaled back to length 1.
export function averageVectors(vectors) {
  if (!vectors.length) return null
  const sum = new Array(vectors[0].length).fill(0)
  for (const v of vectors) for (let i = 0; i < v.length; i++) sum[i] += v[i]
  return normalize(sum.map((x) => x / vectors.length))
}

// pgvector reads vectors as text like "[0.1,0.2,...]".
export const toSql = (v) => `[${v.map((x) => +x.toFixed(6)).join(',')}]`

// The text that represents a chat: every message, cut to a sensible length.
export function chatTexts(messages) {
  return (messages ?? []).map((m) => String(m.content ?? '').trim()).filter(Boolean)
}

export async function embedChat(messages) {
  const texts = chatTexts(messages)
  return texts.length ? averageVectors(await embedMany(texts)) : null
}
