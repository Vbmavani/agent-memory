// STEP 2 of learning memory search: search past chats by MEANING (embeddings + pgvector).
// Each chat is stored as one point of 384 numbers in chats.embedding (server/embed.js makes the
// numbers). A question becomes a point too, and Postgres returns the closest chats; then the best
// message inside each chat is picked. Compare with step 1 (server/search-step1-words.js) using
// `npm run search:compare -- "your question"`. Step 3 (planned): mem0. See docs/search.md.
import { pool } from './db.js'
import { cosine, embed, embedMany, embedChat, toSql } from './embed.js'

// ---------- SQL ----------
// The chats whose embedding is closest to the query's (cosine distance, <=>), with their
// messages so the caller can pick the best-matching message inside each chat.
export async function searchChatsByMeaning(userId, excludeChatId, vectorSql, limit = 8) {
  const { rows } = await pool.query(
    `SELECT id AS "chatId", title, updated_at AS "chatDate", messages,
            1 - (embedding <=> $3::vector) AS similarity
     FROM chats
     WHERE user_id = $1 AND id IS DISTINCT FROM $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $3::vector
     LIMIT $4`,
    [userId, excludeChatId, vectorSql, limit])
  return rows
}

export async function setChatEmbedding(userId, chatId, vectorSql) {
  await pool.query('UPDATE chats SET embedding = $3::vector WHERE id = $1 AND user_id = $2',
    [chatId, userId, vectorSql])
}

// For the backfill script: chats that have no embedding yet.
export async function chatsWithoutEmbedding(limit = 200) {
  const { rows } = await pool.query(
    'SELECT id, user_id AS "userId", messages FROM chats WHERE embedding IS NULL ORDER BY updated_at DESC LIMIT $1', [limit])
  return rows
}

// ---------- search ----------
// Similarity cut-offs (cosine, 0..1) for this model, picked by running `npm run search:compare` on
// real chats: clear matches score ~0.35-0.7 ("what is my pet called" -> "my cat is called Pixel" 0.56),
// noise ~0.0-0.3. Known blind spot: this small model barely links "team sync" and "standup" (0.17),
// which is exactly where step 1 (words) plus a self-learned search lesson still helps.
export const MIN_SEARCH_SIMILARITY = 0.3   // the model asked to search: show anything plausibly related
export const MIN_RECALL_SIMILARITY = 0.4   // added to the prompt unasked: only clearly related chats
const CANDIDATE_CHATS = 12

const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s ?? null)

// STEP 2: closest chats by their embedding, then the best-matching message inside each one, so the
// model gets the actual exchange (same result shape as the word search).
export async function searchByMeaning(userId, excludeChatId, query, { limit = 6, min = MIN_SEARCH_SIMILARITY, queryVector } = {}) {
  const qv = queryVector ?? await embed(query)
  const chats = await searchChatsByMeaning(userId, excludeChatId, toSql(qv), CANDIDATE_CHATS)
  const hits = []
  for (const c of chats) {
    const msgs = c.messages ?? []
    const vectors = await embedMany(msgs.map((m) => m.content))
    let best = -1, bestScore = -1
    vectors.forEach((v, i) => { const s = cosine(qv, v); if (s > bestScore) { bestScore = s; best = i } })
    if (best < 0) continue
    // A message can match well even if the chat as a whole drifted to other topics, and vice versa.
    const score = Math.max(bestScore, c.similarity)
    if (score < min) continue
    const m = msgs[best]
    hits.push({
      chat: c.title, chatId: c.chatId, date: m.at ?? c.chatDate, role: m.role,
      message: cut(m.content, 600), before: cut(msgs[best - 1]?.content, 300), after: cut(msgs[best + 1]?.content, 300),
      similarity: +score.toFixed(2), matchedBy: 'meaning',
    })
  }
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
}

// After every saved turn: recompute the chat's embedding from all its messages.
export async function refreshChatEmbedding(userId, chat) {
  const v = await embedChat(chat.messages)
  if (v) await setChatEmbedding(userId, chat.id, toSql(v))
}
