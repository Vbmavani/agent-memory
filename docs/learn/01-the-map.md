# 1. The map: memory types and operations

> *"I want to learn about all types of memory, how it can be useful in AI agents, what different kinds of memory there are, and how I can learn it. I want to try it out by myself and want to change the harness as well."*

The full map is the [Agent Memory Lab](../reference/memory-lab.html) page. This chapter keeps the parts that mattered most, plus the side questions that changed how I think about memory.

## Where memory sits among the agent's parts

On 3 November I asked how many components an agent has. There's no official number. A practical list is: the model, the loop, instructions, tools, MCP, skills, context management, memory, planning and subagents, guardrails, plus evals and the runtime. I mapped it onto my own picture of an agent as a body:

| Body part | Agent part |
|---|---|
| Hippocampus | Long-term memory |
| Eyes | Retrieval (RAG) |
| What the brain is aware of right now | The context window |
| Sleep | Compaction: squeeze the day into a summary |
| Reflexes | Hooks |
| Cerebellum | Skills |

Memory, state and retrieval turned out to be **one topic**: what the agent sees now, what it remembers, and what it can look up. Most agent failures come from that layer, not from missing tools.

## The core idea

An LLM is **stateless**. Between API calls it remembers nothing. Everything an agent "remembers" is either:

- in its **weights**, from training, or
- put back into its **context window** by the harness on every call.

So agent memory is the harness deciding what to store, where to store it, and which pieces to load back at the right moment. That's why changing the harness is the way to learn it, and why I built my own.

## Six types of memory (CoALA)

| Type | Like a person's... | In an agent | In my app |
|---|---|---|---|
| Parametric | General knowledge | Knowledge baked into the weights | DeepSeek's weights |
| Working | What you're holding in mind | The current context window | System prompt + history + tool results |
| Short-term | The last few minutes | This session's messages | `chats.messages` |
| Episodic | "I remember that time…" | Records of past sessions | `search_past_chats` |
| Semantic | Facts you know | Lasting facts about the user or world | `users.facts` |
| Procedural | Riding a bike | How to do things: rules, skills, lessons | `users.procedures` |

## Five operations every memory system does

1. **Write.** What to store, and when. *Hot path:* the agent saves during the conversation. *Background:* a separate process extracts memories later. Store everything and you get noise; store too little and you get amnesia.
2. **Read.** What to load. It can be always loaded (a profile or `CLAUDE.md`), retrieved by relevance, or pulled by the agent when it calls a search tool.
3. **Update and consolidate.** Merge duplicates and fix contradictions. This is where my app's [single writer](02-building-memory.md#semantic-from-two-writers-to-one) came from.
4. **Forget.** Decay, expiry, deleting wrong memories, privacy deletion.
5. **Compress.** Summarize or prune the context so a long task fits.

## Side questions that changed my picture

**Does Claude Code save memories on the hot path?** Mostly, yes. Claude decides in the moment and writes one file per fact into its auto-memory folder, plus a pointer in `MEMORY.md`. It has no special "remember" tool; it uses ordinary file tools and the memory rules in its prompt. Background extraction can be added with a `Stop` or `SessionEnd` hook.

**Who actually runs `search_memory`?** Not the model. The model only asks for the tool; your harness runs the search and returns the result. What sits behind it can be grep, SQL, vectors, a graph or another model call. **Memory is a function, not a table.** The tool's description decides how often the model searches.

> *"Okay, I have to change this perspective of database table when working with memory search…"*

Partly. Database skills move down a layer. Start with *what should the model know right now?*, then *what should come back, and how much?*, and only then *how is it stored?* Fewer, better results win, and memories go stale.

**Is my `CLAUDE.md` memory?** Yes, it's procedural memory. It's loaded into every session and costs tokens on every turn.

**Can I use OpenSearch instead of pgvector?** Yes. OpenSearch is stronger for retrieval: keyword search (BM25), vector search and hybrid ranking in one engine. pgvector is simpler and keeps memory next to the app's data, with real transactions. I stayed with Postgres to keep two tables.

**Is procedural memory like a skill?** Yes. Skills are one of the clearest examples: a stored procedure loaded only when its description matches. Procedural memory ranges from weights, to rules, to skills, to scripts, to lessons the agent learned itself. Everything except weights ends up as text in the context. The storage format (Markdown, a skill folder, a database row with an embedding) only decides how it's found and loaded.

**So OpenSearch's search weights are like model weights?** No. Model weights *hold* knowledge. Search weights only *rank* what's stored. They meet in embeddings, which are produced by a model's weights.

## Three tracks to learn it

The lab page has 12 labs in three tracks:

- **Track A, change Claude Code:** `CLAUDE.md`, auto-memory, compaction, hooks, skills.
- **Track B, build your own harness:** a bare loop with no memory, a sliding window vs a summary, save and search tools, the built-in memory tool, context editing, reflection, evals.
- **Track C, compare frameworks:** Letta, Mem0, Zep, LangGraph.

I took the Track B idea and did it in my own stack instead: a DeepSeek chat app with Postgres. That's [chapter 2](02-building-memory.md).
