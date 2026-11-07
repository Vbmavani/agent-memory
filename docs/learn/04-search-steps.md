# 4. Memory search in steps

> *"I want to be back now and use a method to use in memory to save as vectorization in postgres… how can i use it and search and make it ready for AI model to get something useful"*

Memory is only useful if the right piece comes back at the right time. I learned search in steps, and kept each step in its own file so the next person can learn it the same way.

| Step | Search by | How | Code | Status |
|---|---|---|---|---|
| 1 | **Words** | Postgres full-text search: stop words dropped, the rest stemmed and OR-ed | [`server/search-step1-words.js`](../../server/search-step1-words.js) | done (the original search) |
| 2 | **Meaning** | One embedding per chat (384 numbers) in a pgvector column; closest chats, then the best message in each | [`server/search-step2-meaning.js`](../../server/search-step2-meaning.js), [`server/embed.js`](../../server/embed.js) | done |
| 3 | **A memory layer** | mem0: pulls short memories out of chats and stores, updates and searches them | [`server/search-step3-mem0.js`](../../server/search-step3-mem0.js) | done |

> *"Mention that if you're learning, start from the first step, that search using SQL as the current one, and then next step try this embedding search."*

## Try each step

```bash
SEARCH_MODE=keyword npm run dev   # step 1 only
SEARCH_MODE=meaning npm run dev   # step 2 only
npm run dev                       # steps 1 + 2 (hybrid, the default)
SEARCH_MODE=mem0 npm run dev      # step 3: mem0 (after `npm run mem0:import`)
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
- Auto-recall sometimes matches how a message is *phrased* rather than what it's about.

## Step 3: mem0

> *"Okay set up the mem0 the best way"*

Steps 1 and 2 search chats I store myself. mem0 is a ready-made memory layer: after every reply the app sends the turn to mem0, and mem0 decides what to remember. It extracts short memories, merges them with old ones, and searches them. I imported all 25 chats, turned on `SEARCH_MODE=mem0`, and compared it with step 2 on the same questions:

| Question | Step 2 (meaning) | Step 3 (mem0) |
|---|---|---|
| "what is my pet called" | The raw messages | One clean memory: "User's cat is called Pixel" |
| "team sync" | The question chat | Memories about *earlier searches*, not the standup report |
| "how should you explain tech to me" | My actual correction (0.56) | The same rule from the assistant's side (0.22), with noise close behind |
| "his name is Byte" (a new fact) | Re-embedded with the chat | Merged into "now having two cats: Pixel and Byte" |

What I learned from it:

- **A memory layer gives short, clean facts** and merges updates, which is far less to put in a prompt than whole messages.
- **Out of the box it remembers what *anyone* said.** It saved long assistant explanations, an old wrong claim ("does not have access to previous chats") and the app's own search chatter. My single writer only saves lasting facts about the user, with rules.
- **It doesn't keep one memory per topic.** It held two different standup routines at once.
- **Time matters.** Without sending when a chat happened, mem0 dated old memories "today". With timestamps, they came back as 4 Nov.
- **Writes and deletes are asynchronous.** A fact said now becomes searchable a few seconds later, and a reset right before an import wiped the new memories too.

In the app, *"Remind me what my cat is called?"* was answered in one model call from mem0's auto-recall (top match 0.62).

The full walkthrough, with the SQL and the mem0 setup, is in [Searching past chats](../search.md).
