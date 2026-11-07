# Searching past chats: learning memory search in steps

The agent can look things up in your earlier chats (episodic memory). This app is a learning path
for memory search, one step at a time. **Steps 1, 2 and 3 are all built**, and you can switch between them.

| Step | What | Status | Code |
|---|---|---|---|
| 1 | Search by **words**: plain SQL full-text search | done (the original search, kept as it was) | [`server/search-step1-words.js`](../server/search-step1-words.js) |
| 2 | Search by **meaning**: embeddings stored in Postgres (pgvector) | done | [`server/search-step2-meaning.js`](../server/search-step2-meaning.js), [`server/embed.js`](../server/embed.js) |
| 3 | A memory layer: **mem0** extracts, merges and searches short memories | done | [`server/search-step3-mem0.js`](../server/search-step3-mem0.js) |

**If you are learning, go in order.** Start with step 1, the plain SQL search: it has no model and
no magic, so you can read every line. Once you have seen where it fails, try step 2, embedding
search, and compare the two on the same questions. Then try mem0 and see what a ready-made memory
layer does differently. [`server/search.js`](../server/search.js) only picks the mode and merges.

| | Step 1: by words | Step 2: by meaning |
|---|---|---|
| How | Postgres full-text search (`to_tsvector`, `@@`) | Embeddings (384 numbers per text) + pgvector (`<=>`) |
| Finds | Messages that share words with the query | Messages that are *about* the same thing |
| "what is my pet called" → "my cat is called Pixel" | Missed (no shared word except "called") | Found (similarity 0.56) |
| Exact names, codes, numbers | Good | Weak |
| Needs | Nothing extra | A small local model + the `vector` extension |
| Code | [`server/search-step1-words.js`](../server/search-step1-words.js) | [`server/search-step2-meaning.js`](../server/search-step2-meaning.js), [`server/embed.js`](../server/embed.js) |

## Try each step on its own

Choose the mode when you start the app:

```bash
SEARCH_MODE=keyword npm run dev   # step 1 only: the original SQL word search, no auto-recall
SEARCH_MODE=meaning npm run dev   # step 2 only: embedding search
npm run dev                       # both together (hybrid, the default)
```

Every search card in the chat says which mode ran ("by words (step 1)", "by meaning (step 2)",
"by words + meaning"). Each result has a tag: **words**, **meaning** with a similarity score, or
**both**.

To compare the two steps on your own chats without the chat model:

```bash
npm run search:compare -- "what is my pet called"
```

## Step 1: search by words (SQL)

`searchByWords` in `server/search-step1-words.js` is one SQL query (the original search, unchanged):

1. `plainto_tsquery('english', 'cat name')` turns the query into word stems (`cat & name`). The
   `&` is swapped for `|`, so any word may match.
2. `jsonb_array_elements(c.messages)` turns each chat's message list into rows.
3. `to_tsvector('english', content) @@ query` keeps messages that contain at least one of the words.
4. `ts_rank` orders them by how many words matched and how often. Each hit comes with the message
   before and after it.

Where it fails: different words for the same thing. "team sync" doesn't find a chat about a
"standup". The app works around this with a self-learned lesson (see [tools](tools.md)), but
the search itself can't see meaning.

## Step 2: search by meaning (embeddings)

The idea is the one from the vectors lab (`/vectors.html`): every text becomes a point, and close
points mean similar meaning. Here each point has 384 numbers instead of 3, and a trained model
chooses them instead of you.

### Saving

1. **Text to numbers.** `embed()` in `server/embed.js` runs `all-MiniLM-L6-v2`, a small model
   (~23 MB) that runs inside the Node server. There's no API key, and nothing leaves your machine.
   Each text becomes 384 numbers, scaled to length 1.
2. **One point per chat.** After every reply, `refreshChatEmbedding` embeds each message of the
   chat and averages them into one point (like "a sentence is the average of its words").
3. **Stored in Postgres.** The point goes into `chats.embedding`, a `vector(384)` column. That
   keeps the app at two tables. An HNSW index makes "closest first" fast.

```sql
CREATE EXTENSION vector WITH SCHEMA extensions;
ALTER TABLE chats ADD COLUMN embedding vector(384);
CREATE INDEX ON chats USING hnsw (embedding vector_cosine_ops);
```

### Searching

1. The question becomes 384 numbers with the same model.
2. Postgres returns the 12 chats whose points are closest:
   ```sql
   SELECT id, title, messages, 1 - (embedding <=> $3::vector) AS similarity
   FROM chats WHERE user_id = $1 AND embedding IS NOT NULL
   ORDER BY embedding <=> $3::vector LIMIT 12;
   ```
   `<=>` is the cosine distance, so `1 - distance` is the similarity: 1 means the same meaning, and
   values near 0 mean the texts are unrelated.
3. A chat is one blurry point, so inside each of those chats `searchByMeaning` compares the
   question with every message and keeps the best one. It also keeps the messages around it.
4. Anything under similarity **0.3** is dropped as noise.

### Hybrid (the default)

Both searches run at the same time. `mergeResults` in
[`server/search-results.js`](../server/search-results.js) puts results found by **both** first,
then the other **meaning** results by score, then the remaining **words** results.

## Making it useful to the model

The model never sees the 384 numbers, only the text they point back to. It gets that text in two
ways:

1. **When the model asks.** `search_past_chats` returns messages with the chat title, date,
   neighbours, `similarity` and `matchedBy`. Its description tells the model to describe what it
   wants in plain words, because the search now understands meaning.
2. **Automatically (auto-recall).** Before every reply, `recallForPrompt` searches by meaning with
   the user's new message. Up to 3 chats with similarity **0.4 or more** are added to the system
   prompt under *RELEVANT PAST CONVERSATIONS*. The model can then answer "what's my pet's name?" in
   one call, without a tool. The chat shows this as a 🧭 *Recalled related chats* card. Set
   `AUTO_RECALL=off` to turn it off.

The cut-offs were chosen by running `npm run search:compare` on real chats. Clear matches score
about 0.35 to 0.7, and noise scores 0 to 0.3.

## Limits of this version

- **Small model.** It barely links "team sync" and "standup" (0.17), so step 1 and the
  self-learned search lesson still matter. A bigger embedding model would score this pair higher.
- **One vector per chat.** A long chat that covers many topics becomes one blurry point. The
  best-message step helps, but storing a vector per message or per fact would need a third table.
- **Existing chats** need embeddings once: `npm run embed:chats` fills in any chat without one.

## Step 3: mem0, a ready-made memory layer

Steps 1 and 2 search *our* data: whole chats and their messages, stored and indexed by this app.
mem0 works differently. After every reply the app sends the new user message and reply to mem0
(its hosted platform), and **mem0 decides what to remember**. It pulls out short memories ("User's
cat is called Pixel"), merges them with what it already has (add / update / delete, the same job our
[single writer](how-a-message-works.md) does for `users.facts`), embeds them and stores them on its side.
Searching returns those short memories, not chat messages.

Code: [`server/search-step3-mem0.js`](../server/search-step3-mem0.js).

### Set it up

1. Get an API key from [app.mem0.ai](https://app.mem0.ai) and store it in the Keychain (never in a file):
   ```bash
   security add-generic-password -U -a "$USER" -s mem0-api-key -w
   ```
   Or set `MEM0_API_KEY`.
2. Give mem0 your existing chats once (new turns are sent automatically after every reply):
   ```bash
   npm run mem0:import
   npm run mem0:list     # a minute later: what mem0 remembers
   ```
3. Start the app with step 3 as the search:
   ```bash
   SEARCH_MODE=mem0 npm run dev
   ```

Whatever `SEARCH_MODE` is, every turn is also sent to mem0 while a key is set, so mem0 keeps
learning and `npm run search:compare` can show all three steps side by side. `MEM0=off` stops
sending. **With mem0 on, your chats go to mem0's cloud service**, including anything personal in them.

### Details that matter

- **Writing is asynchronous.** `add` returns `PENDING` right away. mem0 extracts the memories a few
  seconds later, so a fact said now may not be searchable for the next few seconds.
- **Send when it happened.** Each turn is sent with its time (`timestamp`). Without it, mem0 dates
  every memory "now", and imported old chats read as if they were said today.
- **Each memory keeps the chat it came from** (`metadata.chatId`), so results can name the chat.
- **Scores run lower than cosine similarity.** The correct memory for "what is my pet called" scored
  0.42 and noise 0.14–0.19, so the cut-offs are 0.15 for search and 0.25 for auto-recall.
- **Resets are asynchronous too.** `npm run mem0:import -- --reset` deletes everything for the user;
  import again a minute later, or the delete can wipe the new memories as well.
- The mem0 client's usage telemetry is turned off (`MEM0_TELEMETRY=false`), and mem0 only sees the
  app's random user id, never the profile's name or email fields (though chats may mention them).

### What comparing it with steps 1 and 2 showed

On the same 25 chats (`npm run search:compare -- "…"`):

| Question | Step 2 (meaning) | Step 3 (mem0) |
|---|---|---|
| "what is my pet called" | The raw messages, top 0.71 | One clean memory: "User's cat is called Pixel" (0.42) |
| "team sync" | The question chat only (0.68) | Memories *about earlier searches* ("User asked what they reported…"), not the standup report |
| "how should you explain tech to me" | My actual correction, "3 bullets and one example" (0.56) | The same rule, worded from the assistant's side (0.22), with noise close behind |
| A new fact: "his name is Byte" | Embedded with the chat | Merged into one updated memory: "now having two cats: Pixel and Byte" |

What it teaches:

- **mem0 gives short, clean facts** and keeps them up to date by merging, which is much less to put in
  a prompt than whole messages.
- **It remembers whatever was said, including by the assistant.** Out of the box it saved long
  assistant explanations, an old wrong claim ("does not have access to previous chats") and the app's
  own search chatter. Our single writer only saves lasting facts *about the user*, with rules.
- **It doesn't enforce one memory per topic.** It kept two different versions of the standup routine
  (3 questions and 4), where `users.procedures` keeps one per trigger.
- Those are things to tune next with mem0's custom instructions (what to remember and what to skip),
  and to measure with a recall test rather than by eye.
