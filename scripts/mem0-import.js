// Step 3 setup: send every existing chat to mem0 once, oldest first, so it can extract memories
// from your history (new chats are sent automatically after every reply).
//   npm run mem0:import            # send all chats
//   npm run mem0:import -- --reset # forget everything in mem0 for this user (then import again later)
//   npm run mem0:list              # print what mem0 remembers
import * as db from '../server/db.js'
import { allMem0Memories, rememberInMem0, resetMem0 } from '../server/search.js'

const user = await db.currentUser()
if (process.argv.includes('--list')) {
  const mems = await allMem0Memories(user.id)
  console.log(`${mems.length} memories in mem0:`)
  mems.forEach((m) => console.log(`  - ${m.memory}`))
  await db.pool.end()
  process.exit(0)
}
if (process.argv.includes('--reset')) {
  // mem0 deletes in the background, so a reset right before an import can wipe the new memories too.
  console.log('reset:', (await resetMem0(user.id)).message, '- run the import again in a minute, without --reset')
  await db.pool.end()
  process.exit(0)
}

const { rows: chats } = await db.pool.query(
  'SELECT id, title, messages FROM chats WHERE user_id = $1 ORDER BY created_at', [user.id])
console.log(`sending ${chats.length} chats to mem0…`)
for (const c of chats) {
  const r = await rememberInMem0(user.id, c.id, c.messages ?? [])
  console.log(`  ${r ? 'queued' : 'skipped'}: ${c.title.slice(0, 50)}`)
}
console.log('mem0 extracts memories in the background; run `npm run mem0:list` in a minute to see them.')
await db.pool.end()
