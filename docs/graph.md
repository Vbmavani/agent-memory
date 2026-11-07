# Graph memory

Facts are sentences. A **graph** stores the same knowledge as **connections**: nodes (people, places,
things) joined by labelled edges. This app keeps it very simple, so you can see how it works.

```
You –managed_by→ Ana      Ana –lives_in→ Paris      Ana –married_to→ Marc      Marc –works_at→ Louvre
```

"Which city does my manager live in?" becomes a **walk**: start at *You*, follow `managed_by` to Ana
(hop 1), follow `lives_in` to Paris (hop 2). Explainer with an interactive graph:
[How Graph Memory Works](https://claude.ai/artifact/QPsttuLhA2GMiyPZETkU1P) (a Claude artifact).

## Where it lives

| Piece | File | What it does |
|---|---|---|
| Storage | `users.edges` (jsonb, migration `0006`) | One column, so the app still has two tables |
| Extraction | `extractTriples` in [`server/graph.js`](../server/graph.js) | One small model call per message, in parallel with the reply: returns `(from, relation, to)` |
| Merge rules | `mergeEdges` in `server/graph.js` | Plain code: skip duplicates, close the old edge for one-value relations, never delete |
| The walk | `WALK_SQL` / `walkGraph` in [`server/db.js`](../server/db.js) | A recursive query (`WITH RECURSIVE`), built into Postgres, no extension |
| The tool | `explore_graph(entity, hops)` in `server/api.js` | Lets the chat model walk the graph and answer from the connections |
| The lab | `/graph.html` (`src/graph/`) | Draws your graph, walk it by hops, shows the SQL |

## Edges

```json
{ "from": "Ana", "fromKey": "ana", "rel": "lives_in", "to": "Paris", "toKey": "paris",
  "since": "2026-11-07T11:02:00Z", "until": null }
```

- Names are matched by `fromKey` / `toKey` (lowercased, no accents or punctuation), so "Ana" and "ana " are one node. The user is always the node `You`.
- `until` is `null` while the edge is true. **One-value relations** (`lives_in`, `works_at`, `works_as`, `managed_by`, `married_to`): a new value closes the old edge with a date. Other relations keep all their values.
- "I left Acme" ends the `works_at` edge. Closed edges are kept, so history survives. Walks use only open edges unless you ask for history.

## How the walk works

1. Unpack `users.edges` into one row per edge.
2. Start at one node (hop 0).
3. Repeatedly follow every edge touching a node already reached (both directions), one hop further.
4. Never step back onto a node already on the path (so loops end) and stop at the hop limit.

## Try it

- Chat: "My manager Ana lives in Paris and she is married to Marc." The reply shows 🕸 *Connected* rows.
- Ask: "Which city does my manager live in?" The reply shows 🕸 *Walked the graph from You*.
- Open http://localhost:9200/graph.html (the **Graph lab** link in the chat header), or press *Add an example graph* there.
- `GRAPH_MEMORY=off` turns graph memory off.

## Compare vector vs graph (in the chat)

Tick **Compare vector vs graph** in the chat header. Each question is answered twice at the same time,
by two separate model calls: **vector memory** on the left (your past chats, found by meaning) and
**graph memory** on the right (connections walked hop by hop). Nothing is saved while comparing, and
each side may use only its own kind of memory. Leave *with saved facts* unticked to compare the memory
types alone; tick it to see the app as it really runs (the fact memory often answers on its own).

Script to try (use *Switch user* → a new name, so the memory is empty):

1. Type these in **separate new chats** (normal mode): `My manager is Priya.` / `Priya's husband is Sam.` / `Sam works at the Gulbenkian museum.` / `I live in Porto and work at Orbit Labs.` / `Big news: I just moved to Madrid.`
2. Optional: add a dozen unrelated chats about managers, husbands and museums, so vector search has noise to sort through.
3. Tick Compare and ask: `Where does my manager's husband work?`, `What do you know about Priya and the people connected to her?`, `Where do I live now?`
4. Open the **Graph lab** to see the same connections drawn.

What the app showed on this script: both sides answered correctly. Vector memory needed more searches (it reworded
the query to find the next link) and about twice the tokens; graph memory answered with one walk.

## Limits

- The model decides the edges, so a wrong extraction is a wrong connection. Existing edges are given to the extractor so it reuses relation names, but names can still drift (`works_at` vs `employed_by`).
- One name is one node: two different people called Ana become the same node.
- A graph holds connections only. Opinions, numbers and long explanations still belong in facts and search.
- Tested in the app on one small run (two multi-hop questions, both answered correctly), not benchmarked.
