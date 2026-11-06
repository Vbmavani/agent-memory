// The whole of "vector similarity", for vectors of any length (here: 3 numbers per word).

// a · b  = a1*b1 + a2*b2 + a3*b3   (big when both are big in the same places)
export const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0)

// |a| = sqrt(a1² + a2² + a3²)        (the length of the arrow)
export const length = (a) => Math.sqrt(dot(a, a))

// cosine similarity = (a · b) / (|a| × |b|)
//  1 = arrows point the same way, 0 = at right angles (nothing in common)
export function cosine(a, b) {
  const la = length(a)
  const lb = length(b)
  return la && lb ? dot(a, b) / (la * lb) : 0
}

// The angle between the two arrows, in degrees (0° = same direction).
export const angleDeg = (a, b) => (Math.acos(Math.min(1, Math.max(-1, cosine(a, b)))) * 180) / Math.PI

// Every word ranked by how similar it is to `target`, most similar first.
export function nearest(target, words, excludeName = null) {
  return words
    .filter((w) => w.name !== excludeName)
    .map((w) => ({ ...w, score: cosine(target, w.v) }))
    .sort((x, y) => y.score - x.score)
}
