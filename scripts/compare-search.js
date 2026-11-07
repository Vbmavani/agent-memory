// Step 1 vs step 2, side by side, on your real chats:
//   npm run search:compare -- "what is my pet called"
// Prints what the word search finds and what the meaning search finds for the same query.
import * as db from '../server/db.js'
import { searchByMeaning, searchByWords } from '../server/search.js'

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
await db.pool.end()
