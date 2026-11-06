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
| Procedural | done | How the user wants the agent to work: routines they teach ("when I say *standup*…"), rules learned from corrections ("too long, give me 3 bullets"), and lessons the agent learns itself (a search that only worked on retry). Stored in `users.procedures` as `{when, do}`, written by the same single memory decision, followed in every chat. |

## How memory is written (`server/memory.js`)

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

## Procedural memory

Facts say **what** is true about the user; procedures say **how** to work for them. Each is a trigger
and instructions (`when` → `do`), kept one per situation, so refining a routine updates it in place.

- **Taught:** "From now on, when I say 'standup', ask me yesterday / today / blockers one at a time,
  then write a Slack message." Typing `standup` in any new chat runs the routine.
- **From corrections:** after a long answer, "Too long. For tech explanations, give me 3 bullets and
  one example" becomes a rule, so the next explanation, in any chat, follows it. A one-off
  "make that shorter" saves nothing, and neither do your answers while a routine is running.
- **Self-learned:** when `search_past_chats` finds nothing and a reworded retry works, the tool result
  tells the agent, and it records a lesson (`save_procedure` with `self_learned`) so the first
  search works next time.

The chat model's `save_procedure` / `forget_procedure` tools only record requests, like the fact tools;
the single memory decision writes facts and procedures together in one locked transaction. The profile
screen lists every procedure with where it came from (you asked / learned automatically / self-learned)
and lets you delete it.

## Vectors lab

Open http://localhost:9200/vectors.html (or **Vectors lab** in the chat header). Every word is just
3 hand-written numbers: how much it is an animal, how much it is food, how big it is. The page draws
each word as an arrow in 3D, ranks the closest words by cosine similarity, shows the math step by
step, and lets you make your own word with sliders. No model is involved, so every number can be
checked on paper. It is the first step toward vector (embedding) memory. Math in `src/vectors/math.js`.

## Tools the model can call

| Tool | Memory type | What it is | Used for |
|---|---|---|---|
| `search_past_chats` | Episodic | Full-text search over earlier chats, with surrounding messages | "What did I tell you about…", "last time…" |
| `list_recent_chats` | Episodic | Chats from the last N days with title, dates, first message | "What did we talk about this week?" |
| `remember_fact` | Semantic | Records a request to save or correct a fact (never writes itself) | "Remember that…", "correct that…" |
| `forget_fact` | Semantic | Records a request to delete a fact by id | "Forget that…" |
| `save_procedure` | Procedural | Records a routine or rule as `when` + `do`, optionally `self_learned` | Taught routines, rules from corrections, the agent's own lessons |
| `forget_procedure` | Procedural | Records a request to stop following a procedure | "Stop doing the standup thing" |

Lookup tools run straight away. Memory tools only record requests; the single memory decision after
the reply writes them. Every message also gets a background memory decision that is not a tool.

## Docs

- [Tools](docs/tools.md): every tool, the two kinds of tools, the background decision, self-learned lessons
- [How one message works](docs/how-a-message-works.md): the 4 model calls, the single writer, the
  locked database write, source tags, and company rules vs user procedures

## Tests

```bash
npm test             # unit tests (pure memory logic for facts and procedures); database tests run only with TEST_DATABASE_URL
                     # pointing at a separate, disposable database (never the real one)
npm run eval:memory  # live eval: scripted memory scenarios against DeepSeek (needs the API key)
```

## Stack

- Vite + React frontend (`src/`)
- Server routes as a Vite dev-server plugin (`server/api.js`), so the API key never reaches the browser
- Supabase (Postgres) with two tables (`server/db.js`, schema in `supabase/migrations/`):
  - `users`: the profile, plus learned facts (`facts`) and procedures (`procedures`) as jsonb columns
  - `chats`: one row per chat, with its full history in a `messages` jsonb column
- Row Level Security is on for both tables, so Supabase's public REST API exposes nothing.
  The app connects over SSL with its own login, `agent_memory_app`, which can only read and
  write rows in these two tables (no schema changes, no other data).

## Run it locally

1. Store your DeepSeek key in the macOS Keychain (it is read at runtime, never written to a file):
   ```bash
   security add-generic-password -U -a "$USER" -s deepseek-api-key -w
   ```
   Or set `DEEPSEEK_API_KEY` in your environment.
2. Store the database connection string (Supabase session pooler, user `agent_memory_app.<project-ref>`)
   in the Keychain. It contains a password, so it never goes in a file:
   ```bash
   security add-generic-password -U -a "$USER" -s agent-memory-database-url -w
   ```
   Or set `DATABASE_URL`. For a new Supabase project, apply `supabase/migrations/` first.
   Set `DATABASE_CA_CERT` to Supabase's CA file to also verify the server certificate.
3. Install and start:
   ```bash
   npm install
   npm run dev
   ```
   Open http://localhost:9200.
