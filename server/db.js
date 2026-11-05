// Postgres storage. Exactly two tables:
//   users  - the profile (name, email, bio) + `facts`: semantic memory the agent learned (jsonb array)
//   chats  - one row per chat session; its full history lives in `messages` (jsonb array)
// Hosted on Supabase (Postgres). The connection string contains the database password, so it is
// never stored in a file: it comes from env DATABASE_URL, else the macOS Keychain entry
// "agent-memory-database-url". Remote databases are always reached over SSL.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import pg from 'pg'
import { mergeFacts, mergeProcedures } from './memory.js'

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  try {
    return execFileSync('security',
      ['find-generic-password', '-a', process.env.USER, '-s', 'agent-memory-database-url', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new Error('No database configured: set DATABASE_URL or the Keychain entry "agent-memory-database-url".')
  }
}

// SSL for anything that is not localhost. Set DATABASE_CA_CERT to a CA file (Supabase dashboard ->
// Database -> SSL certificate) to also verify the server's certificate; otherwise the connection is
// encrypted but the certificate is not checked.
function connectionConfig(raw) {
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  url.searchParams.delete('sslmode') // ssl is configured below, not by the URL
  const ca = process.env.DATABASE_CA_CERT && fs.readFileSync(process.env.DATABASE_CA_CERT, 'utf8')
  return {
    connectionString: url.toString(),
    ssl: local ? false : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: 5,                        // stay well inside the free pooler's connection limit
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  }
}

export const pool = new pg.Pool(connectionConfig(databaseUrl()))
pool.on('error', (e) => console.error('[db] idle client error:', e.message)) // e.g. pooler restarts

// Creates the schema on a brand-new database. On Supabase the tables already exist (created by
// migration) and the app's login deliberately has no DDL rights, so it skips this.
async function createSchemaIfMissing() {
  const { rows: [r] } = await pool.query(
    "SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.chats') IS NOT NULL AS ok")
  if (r.ok) return
  await pool.query(SCHEMA_SQL)
}

let ready
export function init() {
  ready ??= createSchemaIfMissing().catch((e) => { ready = null; throw e })
  return ready
}

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS users (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL,
      email       text UNIQUE,
      bio         text NOT NULL DEFAULT '',
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chats (
      id          uuid PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       text NOT NULL,
      messages    jsonb NOT NULL DEFAULT '[]',
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chats_user_updated_idx ON chats (user_id, updated_at DESC);
    -- semantic memory: [{id, text, createdAt, updatedAt, source: {chatId}, previous: [older texts]}]
    ALTER TABLE users ADD COLUMN IF NOT EXISTS facts jsonb NOT NULL DEFAULT '[]';
    -- procedural memory: [{id, when, do, createdAt, updatedAt, source, previous}]
    ALTER TABLE users ADD COLUMN IF NOT EXISTS procedures jsonb NOT NULL DEFAULT '[]';
    -- keep both tables away from Supabase's public REST API; the app connects as the owner
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
`

// ---------- users ----------
const USER_COLS = 'id, name, email, bio, facts, procedures, created_at AS "createdAt", updated_at AS "updatedAt"'

// Single-user local app: the profile is the oldest user row (created on first run).
export async function currentUser() {
  await init()
  const { rows: [u] } = await pool.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at LIMIT 1`)
  if (u) return u
  const { rows: [created] } = await pool.query(`INSERT INTO users (name) VALUES ('Me') RETURNING ${USER_COLS}`)
  return created
}

export async function updateUser(id, { name, email, bio }) {
  const { rows: [u] } = await pool.query(
    `UPDATE users SET name = $2, email = $3, bio = $4, updated_at = now()
     WHERE id = $1 RETURNING ${USER_COLS}`,
    [id, name, email || null, bio ?? ''])
  return u
}

// ---------- long-term memory: facts (semantic) and procedures (procedural) ----------
// Apply validated operations (from server/memory.js) in one transaction. The row is locked
// (FOR UPDATE), so concurrent messages are applied one after another and never lose a write;
// mergeItems rejects stale ops (item changed since the decision) and near-duplicates.
// Returns { facts: {changed, skipped}, procedures: {changed, skipped} }.
export async function applyMemoryOps(userId, { facts: factOps = [], procedures: procOps = [] }, source) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [row] } = await client.query('SELECT facts, procedures FROM users WHERE id = $1 FOR UPDATE', [userId])
    const f = mergeFacts(row?.facts ?? [], factOps, { source })
    const p = mergeProcedures(row?.procedures ?? [], procOps, { source })
    if (f.changed.length || p.changed.length) {
      await client.query('UPDATE users SET facts = $2, procedures = $3 WHERE id = $1',
        [userId, JSON.stringify(f.facts), JSON.stringify(p.procedures)])
    }
    await client.query('COMMIT')
    return { facts: { changed: f.changed, skipped: f.skipped }, procedures: { changed: p.changed, skipped: p.skipped } }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function applyFactOps(userId, ops, source) {
  return (await applyMemoryOps(userId, { facts: ops }, source)).facts
}

// The user removes a fact or procedure by hand from the profile screen.
async function removeItem(userId, column, itemId) {
  const { rows: [u] } = await pool.query(
    `UPDATE users SET ${column} = coalesce(
       (SELECT jsonb_agg(x) FROM jsonb_array_elements(${column}) x WHERE x->>'id' <> $2), '[]')
     WHERE id = $1 RETURNING ${USER_COLS}`, [userId, itemId])
  return u
}
export const deleteFact = (userId, id) => removeItem(userId, 'facts', id)
export const deleteProcedure = (userId, id) => removeItem(userId, 'procedures', id)

// ---------- chats ----------
const CHAT_COLS = 'id, title, messages, created_at AS "createdAt", updated_at AS "updatedAt"'

export async function listChats(userId) {
  const { rows } = await pool.query(
    `SELECT id, title, updated_at AS "updatedAt", jsonb_array_length(messages) AS count
     FROM chats WHERE user_id = $1 ORDER BY updated_at DESC`, [userId])
  return rows
}

export async function getChat(userId, id) {
  const { rows: [c] } = await pool.query(
    `SELECT ${CHAT_COLS} FROM chats WHERE id = $1 AND user_id = $2`, [id, userId])
  return c ?? null
}

export async function deleteChat(userId, id) {
  await pool.query('DELETE FROM chats WHERE id = $1 AND user_id = $2', [id, userId])
}

// ---------- episodic memory: searching the user's OTHER chats (used by the model's tools) ----------

// Full-text search over every message of the user's other chats. Words are OR-ed
// ("cat name" matches "my cat is called Pixel"), ranked by relevance, newest first on ties.
// Each hit comes with the message before and after it, so the model sees the exchange.
export async function searchPastChats(userId, excludeChatId, query, limit = 6) {
  const { rows } = await pool.query(
    `WITH q AS (
       SELECT to_tsquery('english', nullif(replace(plainto_tsquery('english', $3)::text, '&', '|'), '')) AS tsq
     )
     SELECT c.id AS "chatId", c.title, c.updated_at AS "chatDate",
            m.msg->>'role' AS role, m.msg->>'content' AS content, m.msg->>'at' AS at,
            c.messages->(m.idx::int - 2)->>'content' AS before,
            c.messages->(m.idx::int)->>'content' AS after,
            ts_rank(to_tsvector('english', m.msg->>'content'), q.tsq) AS rank
     FROM chats c
     CROSS JOIN LATERAL jsonb_array_elements(c.messages) WITH ORDINALITY AS m(msg, idx)
     CROSS JOIN q
     WHERE c.user_id = $1 AND c.id IS DISTINCT FROM $2 AND q.tsq IS NOT NULL
       AND to_tsvector('english', m.msg->>'content') @@ q.tsq
     ORDER BY rank DESC, c.updated_at DESC
     LIMIT $4`,
    [userId, excludeChatId, query, limit])
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s ?? null)
  return rows.map((r) => ({
    chat: r.title,
    chatId: r.chatId,
    date: r.at ?? r.chatDate,
    role: r.role,
    message: cut(r.content, 600),
    before: cut(r.before, 300),
    after: cut(r.after, 300),
  }))
}

// The user's other chats from the last N days: title, dates, size and how each started.
export async function listRecentChats(userId, excludeChatId, days = 7, limit = 15) {
  const { rows } = await pool.query(
    `SELECT title, created_at AS started, updated_at AS "lastMessage",
            jsonb_array_length(messages) AS messages,
            left(messages->0->>'content', 200) AS "firstMessage"
     FROM chats
     WHERE user_id = $1 AND id IS DISTINCT FROM $2
       AND updated_at >= now() - make_interval(days => $3)
     ORDER BY updated_at DESC LIMIT $4`,
    [userId, excludeChatId, days, limit])
  return rows
}

// Save one completed turn (user message + assistant reply) in a single statement.
// Creates the chat row if it is new, otherwise appends to its history.
export async function saveTurn({ userId, chatId, title, turn }) {
  const { rows: [c] } = await pool.query(
    `INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET messages = chats.messages || EXCLUDED.messages, updated_at = now()
       WHERE chats.user_id = EXCLUDED.user_id
     RETURNING ${CHAT_COLS}`,
    [chatId, userId, title, JSON.stringify(turn)])
  return c
}
