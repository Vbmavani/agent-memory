// Postgres storage. Exactly two tables:
//   users  - the profile (name, email, bio) + `facts`: semantic memory the agent learned (jsonb array)
//   chats  - one row per chat session; its full history lives in `messages` (jsonb array)
// Local default: database "deepseek_playground" on localhost:5432 as the current macOS user
// (Postgres.app). Override with DATABASE_URL.
import pg from 'pg'
import { mergeFacts } from './memory.js'

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/deepseek_playground',
})

let ready
export function init() {
  ready ??= pool.query(`
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
  `).catch((e) => { ready = null; throw e })
  return ready
}

// ---------- users ----------
const USER_COLS = 'id, name, email, bio, facts, created_at AS "createdAt", updated_at AS "updatedAt"'

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

// ---------- semantic memory: learned facts about the user ----------
// Apply validated operations (from server/memory.js) in one transaction. The row is locked
// (FOR UPDATE), so concurrent messages are applied one after another and never lose a write;
// mergeFacts rejects stale ops (fact changed since the decision) and near-duplicates.
// Returns { changed, skipped }.
export async function applyFactOps(userId, ops, source) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [row] } = await client.query('SELECT facts FROM users WHERE id = $1 FOR UPDATE', [userId])
    const { facts, changed, skipped } = mergeFacts(row?.facts ?? [], ops, { source })
    if (changed.length) await client.query('UPDATE users SET facts = $2 WHERE id = $1', [userId, JSON.stringify(facts)])
    await client.query('COMMIT')
    return { changed, skipped }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// The user removes a fact by hand ("forget this").
export async function deleteFact(userId, factId) {
  const { rows: [u] } = await pool.query(
    `UPDATE users SET facts = coalesce(
       (SELECT jsonb_agg(f) FROM jsonb_array_elements(facts) f WHERE f->>'id' <> $2), '[]')
     WHERE id = $1 RETURNING ${USER_COLS}`, [userId, factId])
  return u
}

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
