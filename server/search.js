// Searching the user's other chats: STEP 1 (words), STEP 2 (meaning), or both.
// Step 1 is in search-step1-words.js, step 2 in search-step2-meaning.js; this file only picks the
// mode and merges. Step 3 of learning memory (planned) is mem0.
//
// Pick the mode with the SEARCH_MODE env var when you start the app, to learn them one at a time:
//   SEARCH_MODE=keyword  -> step 1 only: Postgres full-text search, the original way
//   SEARCH_MODE=meaning  -> step 2 only: embedding search (pgvector)
//   SEARCH_MODE=hybrid   -> both, merged (default; what you want in practice)
// AUTO_RECALL=off turns off the automatic "relevant past conversations" in the prompt.
import { searchByWords } from './search-step1-words.js'
import { MIN_RECALL_SIMILARITY, searchByMeaning } from './search-step2-meaning.js'
import { mergeResults } from './search-results.js'

export { searchByWords } from './search-step1-words.js'
export { searchByMeaning, refreshChatEmbedding, chatsWithoutEmbedding } from './search-step2-meaning.js'

export const SEARCH_MODES = ['keyword', 'meaning', 'hybrid']
export const searchMode = () => (SEARCH_MODES.includes(process.env.SEARCH_MODE) ? process.env.SEARCH_MODE : 'hybrid')
export const autoRecallOn = () => process.env.AUTO_RECALL !== 'off' && searchMode() !== 'keyword'

// What the search_past_chats tool runs.
export async function searchPastChats(userId, excludeChatId, query, limit = 6) {
  const mode = searchMode()
  if (mode === 'keyword') {
    return (await searchByWords(userId, excludeChatId, query, limit)).map((h) => ({ ...h, matchedBy: 'words' }))
  }
  if (mode === 'meaning') return searchByMeaning(userId, excludeChatId, query, { limit })
  const [words, meaning] = await Promise.all([
    searchByWords(userId, excludeChatId, query, limit),
    searchByMeaning(userId, excludeChatId, query, { limit }),
  ])
  return mergeResults(words, meaning, limit)
}

// Before every reply: find past chats clearly related to the new message, without the model
// having to ask. They are added to the system prompt (see systemPrompt in server/api.js).
export async function recallForPrompt(userId, chatId, text, limit = 3) {
  if (!autoRecallOn() || text.trim().length < 12) return []
  try {
    return await searchByMeaning(userId, chatId, text, { limit, min: MIN_RECALL_SIMILARITY })
  } catch (e) {
    console.warn('[recall] skipped:', e.message)
    return []
  }
}
