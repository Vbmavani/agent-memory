// Give every chat that has no embedding yet its 384 numbers (run once after adding step 2,
// and any time chats were saved while embedding was unavailable).
//   npm run embed:chats
import * as db from '../server/db.js'
import { chatsWithoutEmbedding, refreshChatEmbedding } from '../server/search.js'

const chats = await chatsWithoutEmbedding(500)
console.log(`${chats.length} chats without an embedding`)
let done = 0
for (const c of chats) {
  await refreshChatEmbedding(c.userId, c)
  done++
}
console.log(`embedded ${done} chats`)
await db.pool.end()
