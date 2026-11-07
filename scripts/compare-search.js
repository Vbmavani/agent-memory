// Step 1 vs step 2 vs step 3, side by side, on your real chats:
//   npm run search:compare -- "what is my pet called"
// Prints what the word search, the meaning search and mem0 find for the same query.
import * as db from '../server/db.js'
import { mem0Enabled, searchByMeaning, searchByWords, searchMem0 } from '../server/search.js'

const query = process.argv.slice(2).join(' ').trim()
if (!query) { console.error('usage: npm run search:compare -- "your question"'); process.exit(1) }
const user = await db.currentUser()
const show = (h) => `  - [${h.chat}] ${h.role}: ${String(h.message).replace(/\s+/g, ' ').slice(0, 90)}` +
  (h.similarity != null ? `  (similarity ${h.similarity})` : '')

const words = await searchByWords(user.id, null, query, 5)
console.log(`\nSTEP 1 - by words (Postgres full-text search): ${words.length} found`)
words.forEach((h) => console.log(show(h)))

const meaning = await searchByMeaning(user.id, null, query, { limit: 5 })
console.log(`\nSTEP 2 - by meaning (embeddings + pgvector): ${meaning.length} found`)
meaning.forEach((h) => console.log(show(h)))

if (mem0Enabled()) {
  const mem = await searchMem0(user.id, query, { limit: 5, min: 0 })
  console.log(`\nSTEP 3 - mem0 (memories it extracted): ${mem.length} found`)
  mem.forEach((h) => console.log(show(h)))
} else console.log('\nSTEP 3 - mem0: off (no key, or MEM0=off)')
await db.pool.end()
