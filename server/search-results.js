// Pure helpers for combining step 1 (words) and step 2 (meaning) results. No database, no model,
// so they are unit-tested in test/embed.test.js.

// Merge word hits and meaning hits: found by both first, then by meaning (best score first),
// then the remaining word hits in their own order. Duplicates (same message) are merged.
export function mergeResults(wordHits, meaningHits, limit = 6) {
  const key = (h) => `${h.chatId}|${(h.message ?? '').slice(0, 80)}`
  const byKey = new Map()
  for (const h of meaningHits) byKey.set(key(h), { ...h })
  const words = []
  for (const h of wordHits) {
    const existing = byKey.get(key(h))
    if (existing) existing.matchedBy = 'both'
    else words.push({ ...h, matchedBy: 'words' })
  }
  const meaning = [...byKey.values()]
  const both = meaning.filter((h) => h.matchedBy === 'both')
  const onlyMeaning = meaning.filter((h) => h.matchedBy !== 'both')
  return [...both, ...onlyMeaning, ...words].slice(0, limit)
}
