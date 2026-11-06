# Tools the chat model can call

The chat model gets **6 tools**, defined in the `TOOLS` list in [`server/api.js`](../server/api.js).
They cover three kinds of memory.

| Tool | Memory type | What it is | What it is used for |
|---|---|---|---|
| `search_past_chats` | Episodic | Full-text search over the user's earlier chats (not the current one). Returns matching messages with chat title, date, and the messages around them. | "What did I tell you about…", "last time…", "remember when…". |
| `list_recent_chats` | Episodic | Lists chats from the last N days: title, dates, size, first message. | "What did we talk about yesterday / this week?" |
| `remember_fact` | Semantic | Records a request to save or correct a fact about the user (e.g. "User lives in Lyon"). Does not write anything itself. | The user explicitly says "remember that…" or "actually, correct that…". |
| `forget_fact` | Semantic | Records a request to delete a stored fact, by id. | "Forget that…", "that's no longer true". |
| `save_procedure` | Procedural | Records a request to save a routine or rule as a trigger (`when`) plus steps (`do`). Can be marked `self_learned`. | Routines the user teaches ("when I say standup…"), rules from corrections ("3 bullets for tech"), and the agent's own lessons. |
| `forget_procedure` | Procedural | Records a request to stop following a procedure, by id. | "Stop doing the standup thing". |

## Two kinds of tools

- **Lookup tools** (`search_past_chats`, `list_recent_chats`) run straight away against Postgres and
  return results to the model, which then answers from them.
- **Memory tools** (`remember_fact`, `forget_fact`, `save_procedure`, `forget_procedure`) **never
  write**. They only add a request to `ctx.memoryRequests` and return `{ok: true, status: "recorded"}`.
  The single memory decision after the reply does the actual write. See
  [how-a-message-works.md](how-a-message-works.md).

## Not a tool: the background memory decision

Every message also gets one memory decision (`decideMemory` in [`server/memory.js`](../server/memory.js)).
The model does not call it. It runs in parallel with the reply and saves facts and procedures
automatically when the chat model did not call a memory tool (for example "by the way, I moved to
Berlin" or "too long, for tech explanations give me 3 bullets").

## Self-learned lessons

When `search_past_chats` finds nothing and a reworded retry in the same turn works, the second
result carries a `lesson` note telling the model what happened. The model then calls
`save_procedure` with `self_learned: true` (for example "a standup may be called a team sync, so
search several wordings"). It is tagged **self-learned** in the UI.
