// Searching the user's other chats: STEP 1 (words), STEP 2 (meaning), both, or STEP 3 (mem0).
// Step 1 is in search-step1-words.js, step 2 in search-step2-meaning.js, step 3 in
// search-step3-mem0.js; this file only picks the mode and merges.
//
// Pick the mode with the SEARCH_MODE env var when you start the app, to learn them one at a time:
//   SEARCH_MODE=keyword  -> step 1 only: Postgres full-text search, the original way
//   SEARCH_MODE=meaning  -> step 2 only: embedding search (pgvector)
//   SEARCH_MODE=hybrid   -> both, merged (default; what you want in practice)
//   SEARCH_MODE=mem0     -> step 3: memories extracted and searched by mem0 (needs the mem0 key)
// Whatever the mode, every saved turn is also sent to mem0 when a key is set (MEM0=off to stop),
// so mem0 keeps learning and the three steps can be compared on the same chats.
// AUTO_RECALL=off turns off the automatic "relevant past conversations" in the prompt.
import { searchByWords } from './search-step1-words.js'
import { MIN_RECALL_SIMILARITY, searchByMeaning } from './search-step2-meaning.js'
import { MIN_MEM0_RECALL, searchMem0 } from './search-step3-mem0.js'
import { mergeResults } from './search-results.js'

export { searchByWords } from './search-step1-words.js'
export { searchByMeaning, refreshChatEmbedding, chatsWithoutEmbedding } from './search-step2-meaning.js'
export { searchMem0, rememberInMem0, mem0Enabled, allMem0Memories, resetMem0 } from './search-step3-mem0.js'

export const SEARCH_MODES = ['keyword', 'meaning', 'hybrid', 'mem0']
// The mode can also be picked per message in the chat UI (the "Search" menu); the env var is the default.
export const searchMode = (override) => SEARCH_MODES.includes(override) ? override
  : SEARCH_MODES.includes(process.env.SEARCH_MODE) ? process.env.SEARCH_MODE : 'hybrid'
export const autoRecallOn = (mode = searchMode()) => process.env.AUTO_RECALL !== 'off' && mode !== 'keyword'

// What the search_past_chats tool runs.
export async function searchPastChats(userId, excludeChatId, query, limit = 6, modeOverride) {
  const mode = searchMode(modeOverride)
  if (mode === 'keyword') {
    return (await searchByWords(userId, excludeChatId, query, limit)).map((h) => ({ ...h, matchedBy: 'words' }))
  }
  if (mode === 'meaning') return searchByMeaning(userId, excludeChatId, query, { limit })
  if (mode === 'mem0') return searchMem0(userId, query, { limit })
  const [words, meaning] = await Promise.all([
    searchByWords(userId, excludeChatId, query, limit),
    searchByMeaning(userId, excludeChatId, query, { limit }),
  ])
  return mergeResults(words, meaning, limit)
}

// Before every reply: find past chats clearly related to the new message, without the model
// having to ask. They are added to the system prompt (see systemPrompt in server/api.js).
export async function recallForPrompt(userId, chatId, text, limit = 3, modeOverride) {
  const mode = searchMode(modeOverride)
  if (!autoRecallOn(mode) || text.trim().length < 12) return []
  try {
    return mode === 'mem0'
      ? await searchMem0(userId, text, { limit, min: MIN_MEM0_RECALL })
      : await searchByMeaning(userId, chatId, text, { limit, min: MIN_RECALL_SIMILARITY })
  } catch (e) {
    console.warn('[recall] skipped:', e.message)
    return []
  }
}
