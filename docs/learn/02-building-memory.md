# 2. Building it, one memory type at a time

Once I had [the map](01-the-map.md), I built a small chat app and added memory types one at a time, checking each one in the UI before moving on. The app is React + DeepSeek (`deepseek-flash`, the cheapest model), with exactly two Postgres tables: `users` and `chats`. All times are UTC.

## The order I built it in

| When | What I added | Memory type | Commit |
|---|---|---|---|
| 5 Nov, 01:15 | A bare chat app. The API key lives in the macOS Keychain, never in a file | none yet | — |
| 5 Nov, 01:24 | Send the chat's full history with every message | Short-term | — |
| 5 Nov, 01:29–01:40 | Store everything in Postgres, in exactly two tables: `users` (profile) and `chats` (history as jsonb) | Short-term | — |
| 5 Nov, 01:42 | Put the profile in the system prompt on every request | Working | — |
| 5 Nov, 01:46 | Tools the model can call to find old chats: `search_past_chats` and `list_recent_chats` | Episodic | 606150a |
| 5 Nov, 02:15 | A background call that pulls lasting facts out of each message into `users.facts` | Semantic | 105ea05 |
| 5 Nov, 02:28 | Hybrid: the background call plus `remember_fact` / `forget_fact` tools | Semantic | c688500 |
| 5 Nov, 12:27 | Redesigned to a **single writer**, with tests and a live eval | Semantic | db9325a |
| 5 Nov, 12:52 | Moved from local Postgres to Supabase, with a least-privilege login | storage | b4ddec6 |
| 5 Nov, 23:46 | Taught routines, rules from corrections, and self-learned lessons in `users.procedures` | Procedural | c92c959 |
| 6 Nov, 00:11 | Docs: [the tools](../tools.md) and [how one message works](../how-a-message-works.md) | — | 40a292c |
| 6 Nov, ~00:30 | A vectors lab: words as 3 numbers, compared by cosine similarity | Vectors (toy) | f50fdb8 |
| 6 Nov, 23:36 | Search past chats by meaning: embeddings in a pgvector column | Episodic, step 2 | 10a26c3 |

## Short-term: just send the history

The first lesson took one change. The model remembers nothing between calls, so "memory" of this chat is the server sending the whole history every time. I asked: *"Can you make it so that it has access to previous chat? then I'll include memory in the flow."* After that, the history lived in Postgres and was rebuilt for every request.

## Episodic: give the model a search tool

> *"Can you add a tool that the AI model can call to find the old chats as well? … That would be kind of episodic memory, right?"*

Yes. The model replies with a tool call, the server runs a Postgres full-text search over the other chats, returns the matches, and the model answers or searches again (up to 4 rounds). Two costs showed up right away: looking things up costs extra tokens, and word search misses synonyms ("pet" doesn't find "cat"). That second one is what led to [vector search](04-search-steps.md) later.

## Semantic: from two writers to one

This took three versions, and it's where I learned the most.

1. **Background only.** A second model call reads every message and returns `add` / `update` / `delete` operations for facts. It ran in parallel with the reply, so there was no extra wait. But the chat model didn't know memory existed, and told me it couldn't remember things while facts were being saved under the same reply.
2. **Hybrid.** I asked *"why you run two AI model chats?"*, got the reasons (a background call checks every message, it's focused, parallel and cheap, while a tool only works if the model decides to call it), and chose both: the background call plus `remember_fact` / `forget_fact` tools.
3. **Single writer.** Then I hit a real bug in the UI. I gave a fact that corrected an existing one. The tool **added** a new fact, and the background call **updated** the old one, so I ended up with two. Each writer was right on its own, and together they broke the store.

The fix: *"two AIs think, one piece of code writes."*
- The chat model's tools only **record a request** in a temporary list for this message.
- One memory decision per message sees the message, the existing facts and those requests, and returns JSON.
- Plain server code validates the JSON. It checks for known ids, stale writes and near-duplicates, and allows one fact per topic. Then it writes everything in a single locked transaction.

A model can't touch the database. It can only return text, and code decides whether that change is allowed. I tested my understanding by asking *"The chat AI model is just writing temporarily in the object or something, right? The actual memory AI model call is actually writing into the database."* The first half was right. For the second half: the memory model only suggests, and the code writes. The 15 unit tests caught a real bug (leading spaces stopped duplicates from being matched), and a live eval checks scripted scenarios against DeepSeek.

## Moving to Supabase

> *"I want to see how data is stored… i want to see on UI"*

I looked at the tables in pgAdmin first, then moved everything to Supabase. I didn't want to handle a database password myself, so the app got its own login that can only read and write rows in the two tables. Its password was generated locally and saved to the Keychain; only a hash went to Supabase. Row Level Security is on because Supabase exposes a web API for every table. The data was copied and checksummed, and the local copy was deleted only after the check passed: migrate, verify, then delete.

## Procedural: how the user wants the agent to work

> *"I want you to let me know how I can try procedural memory. What could be an example based on this Git repo?"*

Procedural memory is "when X happens, do Y". I tried three kinds, and all three worked in the UI:

- **A taught routine:** "when I say standup, ask me what I did yesterday, today, and any blockers, one at a time". It ran in a brand-new chat, and my answers weren't saved as facts.
- **A rule from a correction:** "too long, give me 3 bullets and an example". It carried into the next chat.
- **A self-learned lesson:** a search for "team sync" found nothing, and "standup" worked. The tool result now tells the model when a retry succeeded after a failed search, and the model saved the lesson as a procedure tagged **self-learned**.

Procedures are text in the prompt, so they apply from the next message with no retraining. I asked whether that's set by the user or by the company. Company rules are the fixed system prompt for everyone, and procedures belong to each user. Nothing yet stops a user's procedure from overriding a company rule. That's a known gap.

## Rules I kept the whole way

- **Exactly two tables.** Facts, procedures and later the vectors are all columns on `users` and `chats`.
- **No secrets in git.** Every push is preceded by a scan, and the push only runs if the scan is clean. Test examples taken from real chats were replaced with neutral ones before the repo went public.
- **Test it in the UI**, not just in unit tests.

## Problems worth remembering

| Problem | Lesson |
|---|---|
| The chat model said it couldn't remember, while the background call was saving facts | Each model call only knows what its own prompt says |
| Two writers left two facts about one topic | Two independent writers can each be right and still leave the store inconsistent |
| The model kept repeating its own earlier mistake in a long chat | A wrong statement in short-term memory keeps steering the model |
| A self-learned lesson was tagged "you asked" | Where a memory came from needs its own test |
| A push ran even though the secret scan reported matches | A check that doesn't block isn't a gate |
| One vector per chat blurs chats that cover several topics | Accepted to keep two tables; a per-message table is the next fix |
