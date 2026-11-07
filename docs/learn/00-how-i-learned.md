# 0. How I learned it

I came to memory right after learning Claude Skills, hooks and [MCP](https://vbmavani.github.io/agent-toolkit/mcp/). The plan was to reuse what worked for MCP: get the whole map first, build something small and real, ask "how does it work at the code level?" until I could explain it back, and write everything down.

## The days

All times are UTC.

| When | What I did | Where it's covered |
|---|---|---|
| **3 Nov, 23:12** | Asked which two agent components to study next, then how many components an agent has. Mapped the list onto my own "agent as a body" picture (hippocampus = memory, eyes = retrieval, reflexes = hooks). Picked **context engineering and memory** as the next deep dive. | [Ch 1](01-the-map.md) |
| **4 Nov, 12:57** | Asked for *all* types of memory and every way to try them, including changing the harness. Got the map: six memory types, five operations, 12 labs. Turned it into the [Agent Memory Lab](../reference/memory-lab.html) page, then had it pasted back into chat so I could ask about single lines. | [Ch 1](01-the-map.md) |
| **4 Nov, 14:18–22:36** | Asked line by line: does Claude Code save memories on the "hot path"? Who actually runs `search_memory`? Realized memory is "a function, not a table". Opened my own `CLAUDE.md` as procedural memory (Lab 01). | [Ch 1](01-the-map.md) |
| **4 Nov, 23:37 – 5 Nov, 00:38** | Side questions: what's in the system prompt, whether the Python labs need an API key, OpenSearch vs pgvector, whether skills are procedural memory and how procedural memory is stored. | [Ch 1](01-the-map.md), [Ch 5](05-reading-and-research.md) |
| **5 Nov, 01:13–02:05** | Built a bare DeepSeek chat app, then added **short-term** memory (send the history), Postgres with exactly two tables, the profile in the prompt, and **episodic** memory (a tool to search old chats). Made the repo public after a secret scan. | [Ch 2](02-building-memory.md) |
| **5 Nov, 02:15–02:32** | **Semantic** memory: a background call that extracts facts, then a hybrid with remember/forget tools. | [Ch 2](02-building-memory.md#semantic-from-two-writers-to-one) |
| **5 Nov, 12:27–13:08** | Found two writers creating two facts about one topic, and redesigned to a **single writer** with tests and an eval. Looked at the tables in a UI, then moved everything to Supabase with a least-privilege login. | [Ch 2](02-building-memory.md) |
| **5 Nov, 12:54–14:00** | In parallel: **how does a vector database actually work?** Embedded "king", "queen", "man" and "woman" with a real model. The same text gives the same 384 numbers every time. Learned parameters vs dimensions and the `[CLS]` and `[SEP]` tokens. Side quest: letting an AI use a web app without screenshots. | [Ch 3](03-vectors.md), [Ch 5](05-reading-and-research.md) |
| **5 Nov, 23:10 – 6 Nov, 00:13** | **Procedural** memory: a taught routine, a rule from a correction, and a lesson the agent learned itself. Asked which tool did it and how, at the code level. Wrote the docs. | [Ch 2](02-building-memory.md#procedural-how-the-user-wants-the-agent-to-work) |
| **6 Nov, ~00:15–01:19** | Wanted vectors "very, very basic". Got a vectors lab (3 numbers per word), then the [Words Into Numbers](../reference/words-into-numbers.html) explainer when I still didn't get how the numbers are made. | [Ch 3](03-vectors.md) |
| **6 Nov, 13:48–22:40** | Went through the explainer step by step in a side chat: training from random starts, building my own embedding model on a Mac, then 2-D, 3-D and 4-D simulators with previous and next steps, published as [vector visuals](https://vbmavani.github.io/vector-visuals/). Researched embedding dimensions (MTEB). | [Ch 3](03-vectors.md) |
| **6 Nov, 23:27 – 7 Nov, 00:58** | Back to the app: **search memory by meaning**. Embeddings in a pgvector column, hybrid search, and related chats recalled into the prompt automatically. Kept the SQL word search as step 1, labelled this step 2, and planned mem0 as step 3. | [Ch 4](04-search-steps.md) |
| **7 Nov, 01:22** | Read Anthropic's post [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) as a plain-English page: [How Claude Remembers](../reference/how-claude-remembers.html). | [Ch 5](05-reading-and-research.md) |
| **7 Nov, 02:05** | Put the whole journey into this site. | — |
| **7 Nov, ~12:10** | Asked what to learn next, then set up **mem0** as step 3: every turn sent to mem0, all chats imported, `SEARCH_MODE=mem0`, and compared with step 2 on the same questions. | [Ch 4](04-search-steps.md#step-3-mem0) |

## The method that worked

1. **Ask for the whole map first.** "How many components does an agent have?", then "all types of memory… in detail, so I will take it one by one." Every later question had somewhere to land.
2. **Build one memory type at a time, in a real app.** Short-term, episodic, semantic, procedural, each one checked in the UI before the next.
3. **Ask how it works at the code level.** "I think it is working, but I don't know how it's working." Then restate it in my own words to check: "the chat model is just writing temporarily in the object, right?"
4. **Look at the data where it lives.** Open the tables, see one fact per row, ask where and *when* the vectors are stored.
5. **When stuck, ask for a picture from zero.** The vectors explainer and the simulators came from "I'm still not able to understand this… from scratch, from zero."
6. **Use artifacts for structure and chat for questions.** I had each artifact pasted back into chat so I could quote one line at a time.
7. **Anchor new ideas to things I already know.** Skills became procedural memory, OpenSearch scoring became ranking, and Claude's model names led to a question about model size.
8. **Write it down as a learning path for the next person.** "If you're learning, start from the first step, the SQL search, then try embedding search."

## If you're starting today

- **Read in this order:** the [Agent Memory Lab](../reference/memory-lab.html) map, then [chapter 2](02-building-memory.md) while you run the app, then [Words Into Numbers](../reference/words-into-numbers.html) before [memory search step 2](04-search-steps.md), then [How Claude Remembers](../reference/how-claude-remembers.html) for where this is heading.
- **Start with `SEARCH_MODE=keyword`.** See where word search fails before you add vectors.
- **Your goal:** explain out loud what happens to one message: what's sent to the model, what gets remembered, who writes it, and how it comes back next time. If you can do that, you understand agent memory.
- **Time:** the map took an afternoon of questions. The app took about a day and a half. Vectors took another day.
