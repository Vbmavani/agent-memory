// STEP 1 of learning memory search: search past chats by WORDS.
// This is the original search, kept as it was: one Postgres full-text query, no model, no vectors.
// Read this first. Then see where it fails ("what is my pet called" does not find "my cat is
// called Pixel"), and move on to step 2 (server/search-step2-meaning.js). See docs/search.md.
import { pool } from './db.js'

// Full-text search over every message of the user's other chats. Words are OR-ed
// ("cat name" matches "my cat is called Pixel"), ranked by relevance, newest first on ties.
// Each hit comes with the message before and after it, so the model sees the exchange.
export async function searchByWords(userId, excludeChatId, query, limit = 6) {
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
