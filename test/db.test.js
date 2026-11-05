// Database tests for fact storage. They NEVER touch the real database: they only run when
// TEST_DATABASE_URL points at a separate, disposable Postgres (e.g. a Supabase branch or a
// local Postgres), and they only create and delete their own test user there.
//   TEST_DATABASE_URL=postgres://... npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const reachable = Boolean(process.env.TEST_DATABASE_URL)
if (reachable) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL

let db
let userId

before(async () => {
  if (!reachable) return
  db = await import('../server/db.js') // imported after DATABASE_URL points at the test database
  await db.init()
  const { rows: [u] } = await db.pool.query(`INSERT INTO users (name, facts) VALUES ('Test user', '[]') RETURNING id`)
  userId = u.id
})

after(async () => {
  if (!db) return
  await db.pool.query('DELETE FROM users WHERE id = $1', [userId])
  await db.pool.end()
})

const facts = async () => (await db.pool.query('SELECT facts FROM users WHERE id = $1', [userId])).rows[0].facts
const reset = (f) => db.pool.query('UPDATE users SET facts = $2 WHERE id = $1', [userId, JSON.stringify(f)])

test('applyFactOps adds, updates with history, and deletes', async (t) => {
  if (!reachable) return t.skip('set TEST_DATABASE_URL to run database tests')
  await reset([{ id: 'loc', text: 'User lives in Lyon' }])
  let r = await db.applyFactOps(userId, [{ op: 'update', id: 'loc', expect: 'User lives in Lyon', text: 'User lives in Lyon, France' }], { via: 'test' })
  assert.equal(r.changed[0].op, 'update')
  r = await db.applyFactOps(userId, [{ op: 'add', text: 'User has a cat' }], { via: 'test' })
  const after1 = await facts()
  assert.deepEqual(after1.map((f) => f.text), ['User lives in Lyon, France', 'User has a cat'])
  assert.deepEqual(after1[0].previous, ['User lives in Lyon'])
  await db.applyFactOps(userId, [{ op: 'delete', id: r.changed[0].id }], { via: 'test' })
  assert.deepEqual((await facts()).map((f) => f.text), ['User lives in Lyon, France'])
})

test('a stale update is rejected and nothing is written', async (t) => {
  if (!reachable) return t.skip('set TEST_DATABASE_URL to run database tests')
  await reset([{ id: 'loc', text: 'User lives in Berlin' }])
  const r = await db.applyFactOps(userId, [{ op: 'update', id: 'loc', expect: 'User lives in Lyon', text: 'User lives in Lyon, France' }], {})
  assert.equal(r.changed.length, 0)
  assert.equal(r.skipped[0].reason, 'stale')
  assert.equal((await facts())[0].text, 'User lives in Berlin')
})

test('concurrent writes from two messages are both kept (no lost update)', async (t) => {
  if (!reachable) return t.skip('set TEST_DATABASE_URL to run database tests')
  await reset([])
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    db.applyFactOps(userId, [{ op: 'add', text: `User concurrent fact ${i}` }], {})))
  assert.equal((await facts()).length, 10)
})

test('concurrent duplicate adds are stored once', async (t) => {
  if (!reachable) return t.skip('set TEST_DATABASE_URL to run database tests')
  await reset([])
  await Promise.all(Array.from({ length: 5 }, () => db.applyFactOps(userId, [{ op: 'add', text: 'User is in France' }], {})))
  assert.equal((await facts()).length, 1)
})
