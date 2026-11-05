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
| Semantic | done | The profile, plus facts the agent learns: a parallel extraction call decides add / update / delete per message (Mem0-style), facts are stored in `users.facts` and sent with every request. |
| Procedural | not yet | Behaviour rules are hard-coded in the system prompt; nothing is learned yet. |

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
