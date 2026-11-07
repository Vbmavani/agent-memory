# 4. Memory search in steps

> *"I want to be back now and use a method to use in memory to save as vectorization in postgres… how can i use it and search and make it ready for AI model to get something useful"*

Memory is only useful if the right piece comes back at the right time. I learned search in steps, and kept each step in its own file so the next person can learn it the same way.

| Step | Search by | How | Code | Status |
|---|---|---|---|---|
| 1 | **Words** | Postgres full-text search: stop words dropped, the rest stemmed and OR-ed | [`server/search-step1-words.js`](../../server/search-step1-words.js) | done (the original search) |
| 2 | **Meaning** | One embedding per chat (384 numbers) in a pgvector column; closest chats, then the best message in each | [`server/search-step2-meaning.js`](../../server/search-step2-meaning.js), [`server/embed.js`](../../server/embed.js) | done |
| 3 | **A memory layer** | mem0: pulls short memories out of chats and stores, updates and searches them | — | next |

> *"Mention that if you're learning, start from the first step, that search using SQL as the current one, and then next step try this embedding search."*

## Try each step

```bash
SEARCH_MODE=keyword npm run dev   # step 1 only
SEARCH_MODE=meaning npm run dev   # step 2 only
npm run dev                       # both (hybrid, the default)
npm run search:compare -- "what is my pet called"
```

On my own chats, *"what is my pet called"*:

- **Step 1** found the right chat only because of the word "called", buried among unrelated results.
- **Step 2** put the right messages first: similarity 0.64 and 0.56, with no shared words.

## The questions that made it concrete

**Where and when is the vector stored?** In `chats.embedding`, a `vector(384)` column on the same table, so there are still two tables. It's recomputed in the background after every reply, from all of the chat's messages. A one-time script fills in old chats.

**Is it one vector for the whole chat?** Yes. Each message becomes a vector, and the chat's vector is their average. At search time, message vectors are recomputed on the fly to pick the best message inside each close chat. The weak spot: a chat that jumps between topics becomes a blurry average.

**When I search, does it look for words in my sentence?** Step 1 does: "what is my pet called" becomes `pet | call`. Step 2 doesn't look up words at all: the whole sentence becomes one point and is compared with every chat. Hybrid runs both and merges them, putting results found by **both** first.

**So the word dropping happens only in Postgres?** Yes, in `plainto_tsquery` and `to_tsvector`. But a long message ORs many words together, so short queries suit step 1, and whole messages suit step 2.

## Getting it to the model

The model never sees the numbers, only the text they point back to. It gets that text in two ways:

1. **When it asks:** `search_past_chats` returns messages tagged *words*, *meaning* (with a similarity score) or *both*.
2. **Automatically:** before every reply, chats that are clearly related (similarity 0.4 or more) are added to the prompt. The model answered *"what's my pet's name?"* in one call without searching.

## Limits I hit

- The small model barely links "team sync" and "standup" (0.17), so word search and the self-learned search lesson still matter.
- Word search is better for exact names, numbers and codes. That's why both searches stay on.
- Auto-recall sometimes matches how a message is *phrased* rather than what it's about. That's a good thing to compare when I try mem0.

The full walkthrough, with the SQL, is in [Searching past chats](../search.md).
