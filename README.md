# Agent Memory

A small chat app for learning how AI agent memory works, by building each memory type on top of a
real model (DeepSeek) and a real database (Postgres).

## Start here: the learning site

**[vbmavani.github.io/agent-memory](https://vbmavani.github.io/agent-memory/)** is the whole journey in one place, with
the same nav bar on every page: how I learned agent memory day by day, what I built, what I read and
searched, my thinking process, every question I asked, and every explainer I made along the way.

| Page | What it is |
|---|---|
| [Overview](https://vbmavani.github.io/agent-memory/) | The four days on one timeline, the learning path, and where each memory type lives in the app |
| [How I learned it](https://vbmavani.github.io/agent-memory/learn/) | 8 chapters (day-by-day log, the map, building it, vectors, search steps, reading and research, thinking process, question log) plus the app docs |
| [Agent Memory Lab](https://vbmavani.github.io/agent-memory/reference/memory-lab.html) | The map I started from: memory types, five operations, 12 hands-on labs |
| [Words Into Numbers](https://vbmavani.github.io/agent-memory/reference/words-into-numbers.html) | How text becomes vectors, from zero; read it before step 2 of memory search |
| [How Claude Remembers](https://vbmavani.github.io/agent-memory/reference/how-claude-remembers.html) | Anthropic's post on the components of agent memory, in plain English |
| [All artifacts](https://vbmavani.github.io/agent-memory/artifacts.html) | Every page from the journey, including the [vector visuals](https://vbmavani.github.io/vector-visuals/) simulators |

The site's source is [`docs/`](docs/) (published by `.github/workflows/pages.yml`). The **Vectors lab**
runs inside the app at http://localhost:9200/vectors.html (see [Vectors lab](#vectors-lab)).

## Users and the Search menu

- **Several users.** In the sidebar, *Switch user* lists everyone and lets you log in by typing a
  username; a new name creates a new, empty user (no chats, facts, procedures or mem0 memories).
  It is a local learning app, so there are no passwords. The choice is kept in a cookie.
- **Search menu** (header): pick which memory search answers each message: *Words + meaning*
  (steps 1+2, the default), *Words only* (step 1), *Meaning only* (step 2) or *mem0* (step 3).
  `SEARCH_MODE` is now only the default. Every turn is still sent to mem0 whatever you pick.

To compare searches fairly, use a fresh user and delete its saved facts in *Profile* first:
otherwise the facts in the system prompt answer the question before any search runs.

## Memory types

| Type | Status | How it works here |
|---|---|---|
| Parametric | built in | What the model learned in training. Not changed by this app. |
| Working | done | Everything in one model call: system prompt, profile, chat history, tool results. |
| Short-term | done | The current chat's full history is loaded from Postgres and sent with every message. |
| Episodic | done | The model can call `search_past_chats` and `list_recent_chats` to look up earlier chats. Search works by words (step 1, SQL full-text) and by meaning (step 2, embeddings in pgvector); related chats are also recalled into the prompt automatically. See [docs/search.md](docs/search.md). |
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

## Searching past chats: learning memory search in steps

All three steps of learning memory search are built, each in its own file, and you can switch between them.

If you are learning, go in order:

1. **Step 1, by words.** Start the app with `SEARCH_MODE=keyword npm run dev`. `search_past_chats`
   is then the original plain Postgres full-text search in `server/search-step1-words.js`: one SQL
   query, no model. Notice
   where it fails, for example "what is my pet called" against "my cat is called Pixel".
2. **Step 2, by meaning.** Run `npm run dev` (the default is hybrid: both together), or
   `SEARCH_MODE=meaning` for step 2 alone. Each chat is stored as an embedding (384 numbers from a
   small local model) in a `vector` column on `chats`, and Postgres returns the closest chats. Before
   every reply, related chats are also added to the prompt automatically (🧭 *Recalled related chats*).
   Code: `server/search-step2-meaning.js` and `server/embed.js`.
3. **Step 3, mem0.** A ready-made memory layer: after every reply the turn is sent to mem0, which
   extracts and merges short memories ("User's cat is called Pixel") and searches them. Store a key in
   the Keychain (`mem0-api-key`), run `npm run mem0:import` once, then `SEARCH_MODE=mem0 npm run dev`.
   Your chats go to mem0's cloud while a key is set (`MEM0=off` stops it). Code:
   `server/search-step3-mem0.js`; setup and what the comparison showed are in [docs/search.md](docs/search.md#step-3-mem0-a-ready-made-memory-layer).

Compare all three on your own chats with `npm run search:compare -- "your question"`. The full
walkthrough is in [docs/search.md](docs/search.md).

## Tools the model can call

| Tool | Memory type | What it is | Used for |
|---|---|---|---|
| `search_past_chats` | Episodic | Searches earlier chats by words (step 1) and/or meaning (step 2), with surrounding messages, similarity and match type | "What did I tell you about…", "last time…" |
| `list_recent_chats` | Episodic | Chats from the last N days with title, dates, first message | "What did we talk about this week?" |
| `remember_fact` | Semantic | Records a request to save or correct a fact (never writes itself) | "Remember that…", "correct that…" |
| `forget_fact` | Semantic | Records a request to delete a fact by id | "Forget that…" |
| `save_procedure` | Procedural | Records a routine or rule as `when` + `do`, optionally `self_learned` | Taught routines, rules from corrections, the agent's own lessons |
| `forget_procedure` | Procedural | Records a request to stop following a procedure | "Stop doing the standup thing" |

Lookup tools run straight away. Auto-recall (related chats added to the prompt by meaning) is not a
tool; it runs before every reply. Memory tools only record requests; the single memory decision after
the reply writes them. Every message also gets a background memory decision that is not a tool.

## Docs

All of these are also on the [learning site](https://vbmavani.github.io/agent-memory/learn/).

- [Searching past chats](docs/search.md): step 1 (SQL word search), then step 2 (embeddings and
  pgvector), hybrid ranking, auto-recall, similarity cut-offs and limits
- [Tools](docs/tools.md): every tool, the two kinds of tools, the background decision, self-learned lessons
- [How one message works](docs/how-a-message-works.md): the 4 model calls, the single writer, the
  locked database write, source tags, and company rules vs user procedures

## Tests

```bash
npm test             # unit tests (pure memory logic for facts and procedures); database tests run only with TEST_DATABASE_URL
                     # pointing at a separate, disposable database (never the real one)
npm run search:compare -- "what is my pet called"   # step 1 vs step 2 on your real chats
npm run eval:memory  # live eval: scripted memory scenarios against DeepSeek (needs the API key)
```

## Stack

- Vite + React frontend (`src/`)
- Server routes as a Vite dev-server plugin (`server/api.js`), so the API key never reaches the browser
- Supabase (Postgres) with two tables (`server/db.js`, schema in `supabase/migrations/`):
  - `users`: the profile, plus learned facts (`facts`) and procedures (`procedures`) as jsonb columns
  - `chats`: one row per chat, with its full history in a `messages` jsonb column and its
    `embedding` (`vector(384)`, pgvector, HNSW index) for search by meaning
- Step 3 memory layer: [mem0](https://mem0.ai) hosted platform via the `mem0ai` client (optional; telemetry off)
- Embeddings from `all-MiniLM-L6-v2`, running locally in Node via `@huggingface/transformers`
  (`server/embed.js`); no API key, downloaded once (~23 MB) on first use
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
   npm run embed:chats   # once: gives existing chats their embeddings (new chats get one automatically)
   npm run dev           # SEARCH_MODE=keyword | meaning | hybrid (default) | mem0; AUTO_RECALL=off to disable recall
   ```
   Optional, for step 3: store a mem0 API key with
   `security add-generic-password -U -a "$USER" -s mem0-api-key -w` (or set `MEM0_API_KEY`), then run
   `npm run mem0:import` once.
   Open http://localhost:9200.
