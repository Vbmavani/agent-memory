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
import { mergeEdges } from './graph.js'

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
// pgvector lives in the "extensions" schema on Supabase; this makes its `vector` type and `<=>`
// operator visible without schema prefixes (harmless where that schema does not exist).
pool.on('connect', (client) => client.query('SET search_path TO public, extensions').catch(() => {}))

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
    -- graph memory: connections between people, places and things (see server/graph.js)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS edges jsonb NOT NULL DEFAULT '[]';
    -- several users log in by username, so names are unique (ignoring case)
    CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name));
    -- step 2 of past-chat search: one embedding (384 numbers) per chat, searched by meaning
    CREATE EXTENSION IF NOT EXISTS vector;
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS embedding vector(384);
    CREATE INDEX IF NOT EXISTS chats_embedding_idx ON chats USING hnsw (embedding vector_cosine_ops);
    -- keep both tables away from Supabase's public REST API; the app connects as the owner
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
`

// ---------- users ----------
const USER_COLS = 'id, name, email, bio, facts, procedures, edges, created_at AS "createdAt", updated_at AS "updatedAt"'

// Several users, chosen by username (see /api/login). Without a logged-in id, the default user is
// the oldest row (created on first run), so scripts and old sessions keep working.
export async function currentUser(id) {
  await init()
  if (id) {
    const { rows: [u] } = await pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])
    if (u) return u
  }
  const { rows: [u] } = await pool.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at LIMIT 1`)
  if (u) return u
  const { rows: [created] } = await pool.query(`INSERT INTO users (name) VALUES ('Me') RETURNING ${USER_COLS}`)
  return created
}

export async function listUsers() {
  await init()
  const { rows } = await pool.query(
    `SELECT u.id, u.name, (SELECT count(*)::int FROM chats c WHERE c.user_id = u.id) AS chats
     FROM users u ORDER BY u.created_at`)
  return rows
}

// Log in by username: the user with that name (any upper/lower case), or a new one.
// The unique index on lower(name) (migration 0005) makes two logins at once safe.
export async function findOrCreateUser(name) {
  await init()
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (name) VALUES ($1)
     ON CONFLICT ((lower(name))) DO UPDATE SET name = users.name
     RETURNING ${USER_COLS}, (xmax = 0) AS created`, [name])
  return u
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
export const deleteEdge = (userId, id) => removeItem(userId, 'edges', id)
export const deleteProcedure = (userId, id) => removeItem(userId, 'procedures', id)

// ---------- graph memory (server/graph.js) ----------
// Add the connections found in one message, in one locked transaction like applyMemoryOps.
export async function applyGraphTriples(userId, triples, source = {}) {
  if (!triples.length) return []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [row] } = await client.query('SELECT edges FROM users WHERE id = $1 FOR UPDATE', [userId])
    const r = mergeEdges(row?.edges ?? [], triples, source)
    if (r.changed.length) await client.query('UPDATE users SET edges = $2 WHERE id = $1', [userId, JSON.stringify(r.edges)])
    await client.query('COMMIT')
    return r.changed
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// WALK THE GRAPH with plain Postgres: a recursive query (WITH RECURSIVE).
//   edges : the edges unpacked from the jsonb column, one row each (only the ones still true,
//           unless $4 asks for history too)
//   walk  : starts at the first node (depth 0), then repeatedly steps along any edge touching a node
//           it has reached (depth + 1), never back onto a node already on its path (so loops end),
//           and stops at $3 hops. Edges are followed in both directions.
//   last SELECT: every edge the walk touched, with the hop at which it was first reached.
export const WALK_SQL = `WITH RECURSIVE edges AS (
  SELECT e->>'id' AS id, e->>'from' AS "from", e->>'fromKey' AS fk, e->>'rel' AS rel,
         e->>'to' AS "to", e->>'toKey' AS tk, e->>'since' AS since, e->>'until' AS until
  FROM users u, jsonb_array_elements(u.edges) AS e
  WHERE u.id = $1 AND ($4::boolean OR e->>'until' IS NULL)
),
walk(node, depth, path) AS (
  SELECT $2::text, 0, ARRAY[$2::text]
  UNION ALL
  SELECT n.next, w.depth + 1, w.path || n.next
  FROM walk w
  JOIN edges e ON e.fk = w.node OR e.tk = w.node
  CROSS JOIN LATERAL (SELECT CASE WHEN e.fk = w.node THEN e.tk ELSE e.fk END AS next) n
  WHERE w.depth < $3 AND NOT n.next = ANY (w.path)
)
SELECT e.id, e."from", e.rel, e."to", e.since, e.until, min(w.depth) + 1 AS hop
FROM walk w JOIN edges e ON e.fk = w.node OR e.tk = w.node
WHERE w.depth < $3
GROUP BY e.id, e."from", e.rel, e."to", e.since, e.until
ORDER BY hop, e.since`

export async function walkGraph(userId, startKey, hops = 2, { history = false } = {}) {
  const { rows } = await pool.query(WALK_SQL, [userId, startKey, Math.min(4, Math.max(1, hops)), history])
  return rows.map((r) => ({ ...r, hop: Number(r.hop) }))
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

// ---------- episodic memory: the user's OTHER chats (used by the model's tools) ----------
// Searching them lives in its own files, one per learning step (see docs/search.md):
//   server/search-step1-words.js    STEP 1: Postgres full-text search (the original search)
//   server/search-step2-meaning.js  STEP 2: embeddings + pgvector
//   server/search.js                picks the mode (SEARCH_MODE) and merges both

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
