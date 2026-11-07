# 5. What I read and searched

Most of my learning came from asking questions and building. These are the sources behind it: what I actually read or searched, and what I was pointed to for later, kept separate so it's clear which is which.

## What I actually read

| When (UTC) | What | Why | Became |
|---|---|---|---|
| 4 Nov, 22:11 | My own global `CLAUDE.md` | Lab 01: what procedural memory already looks like in Claude Code | [Ch 1](01-the-map.md#side-questions-that-changed-my-picture) |
| 5 Nov, 13:56 | [alibaba/page-agent](https://github.com/alibaba/page-agent) on GitHub | Side quest: can an AI use a web app by reading the page instead of screenshots? | [Below](#side-quest-ai-that-uses-a-web-app) |
| 6 Nov, 13:48 | My [Words Into Numbers](../reference/words-into-numbers.html) explainer, pasted back into chat | To ask about each step in a side chat | [Ch 3](03-vectors.md) |
| 7 Nov, 01:22 | Anthropic, [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) | "I don't know what this blog is about and what it is trying to solve" | [How Claude Remembers](../reference/how-claude-remembers.html) |

## What I searched

| When (UTC) | Search | Looking for |
|---|---|---|
| 5 Nov, 13:54 | `CopilotKit useCopilotAction in-app AI agent operate UI open source` | Ways to let an AI act inside my own web app |
| 5 Nov, 13:54 | `WebMCP navigator.modelContext website expose tools to AI agents` | The browser standard for a page offering tools to an agent |
| 5 Nov, 13:54 | `alibaba page-agent in-page GUI agent DOM no screenshot` | An agent that reads the page's HTML instead of pixels |
| 5 Nov, 13:54 | `site:x.com in-app AI agent controls UI without screenshots WebMCP` | Whether anyone is posting about doing this (nothing specific turned up) |
| 5 Nov, 13:56 | `page-agent alibaba benchmark success rate WebVoyager accuracy` | Hard numbers. No published benchmark exists for page-agent. |
| 6 Nov, 22:37 | `best embedding models MTEB leaderboard 2026 dimensions` | What dimension sizes good embedding models use |

## The blog post, in short

Anthropic's post on [the components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) is the best summary of where this is heading. The full plain-English version is [How Claude Remembers](../reference/how-claude-remembers.html).

- **Memory is a stack of four layers:** transcripts (the full log) → memory notes → wikis built from them → a small context loaded into every session.
- **Writing a note is a bet that it will matter again.** Newer models make better bets. On one benchmark, Opus 5 went from about 0.56 to 0.83 with a memory folder.
- **Tell the model what memory is for, not how to use it.** Strict rules hurt strong models.
- **"Dreaming":** a pass between sessions re-reads transcripts and fixes wrong notes, builds wikis, promotes the important notes to the top, focuses memory on a goal, and fills gaps.
- **Keep the always-loaded layer small,** because a wrong note there spreads into every session.

How it lines up with my app: `chats.messages` is the transcript layer, `users.facts` and `users.procedures` are the memory notes, and the system prompt is the injected context. The single memory decision is a tiny, per-message version of dreaming.

## Recommended reading (pointed to, not read yet)

**Papers**, in the order the [lab page](../reference/memory-lab.html#reading) suggests:

1. *Generative Agents* (Park et al., 2023): memory stream, retrieval scored by recency, importance and relevance, and reflection.
2. *MemGPT* (Packer et al., 2023): paging memory in and out of the context like an operating system.
3. *Reflexion* (Shinn et al., 2023): learning from your own written feedback.
4. *Voyager* (Wang et al., 2023): an agent that grows its own skill library, which is procedural memory.
5. *CoALA* (Sumers et al., 2023): the memory taxonomy used in [chapter 1](01-the-map.md).
6. *Sleep-time compute* (Letta and UC Berkeley, 2025): the idea behind dreaming.

**Benchmarks:** LongMemEval, LoCoMo, MemoryAgentBench, and Continual Learning Bench (from the blog).

**Frameworks to compare:** Letta (MemGPT), **Mem0** (my step 3), Zep / Graphiti, LangGraph checkpointers and Store, and Claude Managed Agents memory stores.

**Vector tools:** the MTEB leaderboard, pgvector, FAISS, Qdrant, Weaviate, Milvus, Pinecone, `sentence-transformers`, Ollama's `nomic-embed-text`, and Apple MLX.

**From the blog:** a dreaming cookbook on the Claude platform, and the knowledge-wiki quickstart in [anthropics/claude-quickstarts](https://github.com/anthropics/claude-quickstarts).

## Side quest: AI that uses a web app

On 5 November I asked whether an assistant could act inside a web app quickly, without taking screenshots. It's not memory, but it came out of the same "make context cheap" thinking. The answer, ranked by speed and accuracy:

1. **Tool calling:** expose the app's actions as tools, with CopilotKit or WebMCP. One model call, most accurate.
2. **A DOM agent** like page-agent, which reads the page's HTML as text.
3. **An accessibility-tree agent.**
4. **A screenshot agent,** the slowest and least accurate.

The practical plan: build tools for the top 15–20 actions, fall back to the DOM agent for the rest, and log which fallbacks are common so they can become tools.
