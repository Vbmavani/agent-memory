# Agent Memory

A small chat app for learning how AI agent memory works, by building each memory type on top of a
real model (DeepSeek) and a real database (Postgres).

## Memory types

| Type | Status | How it works here |
|---|---|---|
| Parametric | built in | What the model learned in training. Not changed by this app. |
| Working | done | Everything in one model call: system prompt, profile, chat history, tool results. |
| Short-term | done | The current chat's full history is loaded from Postgres and sent with every message. |
| Episodic | done | The model can call `search_past_chats` and `list_recent_chats` to look up earlier chats. |
| Semantic | done | The profile, plus facts the agent learns automatically or when asked ("remember / forget that…"). One memory decision per message (see below), stored in `users.facts`, sent with every request. |
| Procedural | not yet | Behaviour rules are hard-coded in the system prompt; nothing is learned yet. |

## How semantic memory is written (`server/memory.js`)

There is exactly **one writer** per message, so two writers can never create overlapping facts
(for example one adding "User is in France" while another updates "User lives in Lyon").

1. While the reply is generated, a cheap `deepseek-flash` call decides add / update / delete from
   the message and the existing facts (Mem0-style), in parallel, so it adds no wait.
2. The chat model's `remember_fact` / `forget_fact` tools do **not** write. They only record what the
   user explicitly asked for. If any were recorded, the decision is made again with those requests,
   so one decision sees everything. If that call fails, the requests are applied literally.
3. `validateOps` keeps only safe operations (known ids, clean text, one decision per fact), and
   `mergeFacts` applies them inside a locked transaction, rejecting stale writes (the fact changed
   since the decision) and near-duplicates ("User likes Thai food!" = "user likes thai food").
4. Rule given to the model: one fact per attribute, so "lives in Lyon" + "in France" becomes
   "lives in Lyon, France".

## Tests

```bash
npm test             # unit tests (pure memory logic) + database tests on a separate test database
npm run eval:memory  # live eval: scripted memory scenarios against DeepSeek (needs the API key)
```

## Stack

- Vite + React frontend (`src/`)
- Server routes as a Vite dev-server plugin (`server/api.js`), so the API key never reaches the browser
- Postgres with two tables (`server/db.js`):
  - `users`: the profile, plus learned facts in a `facts` jsonb column
  - `chats`: one row per chat, with its full history in a `messages` jsonb column

## Run it locally

1. Store your DeepSeek key in the macOS Keychain (it is read at runtime, never written to a file):
   ```bash
   security add-generic-password -U -a "$USER" -s deepseek-api-key -w
   ```
   Or set `DEEPSEEK_API_KEY` in your environment.
2. Run Postgres locally and create the database (tables are created automatically on first request):
   ```bash
   createdb deepseek_playground
   ```
   Connects to `postgres://localhost:5432/deepseek_playground` by default; override with `DATABASE_URL`.
3. Install and start:
   ```bash
   npm install
   npm run dev
   ```
   Open http://localhost:9200.
