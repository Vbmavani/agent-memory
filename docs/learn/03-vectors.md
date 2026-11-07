# 3. Vectors from scratch

> *"I want to understand how vector database actually works?"*

Word search couldn't tell that "pet" means "cat", so the next step for memory was search by meaning, and that needs vectors. This took a full day, because I kept asking *where do the numbers come from?* The pages that finally made it click are [Words Into Numbers](../reference/words-into-numbers.html) and the [vector visuals](https://vbmavani.github.io/vector-visuals/) simulators.

## What a vector database is

- An **embedding model** turns text into a list of numbers: a point in space. Similar meanings get nearby points.
- A **vector database** stores those points and finds the closest ones. Similarity is measured by cosine (do the arrows point the same way?), dot product or plain distance.
- It's fast because of **approximate nearest-neighbour indexes**. HNSW is a layered graph: fast, but memory-hungry. IVF groups points into clusters. PQ compresses vectors. My app uses HNSW in pgvector.
- A full vector database adds filters on metadata, updates and deletes, and hybrid keyword + vector search. pgvector is enough for most projects under about 10 million vectors.

## Is it the same every time?

> *"Every time I embed 'king', will it get the exact same embed?"*

I ran a real model, `all-MiniLM-L6-v2`, on my laptop:

- Every input becomes exactly **384 numbers**.
- "king" embedded six times was **identical, bit for bit**. The same model and the same text always give the same vector.
- king ↔ queen scored 0.685, and **king − man + woman** landed closest to **queen** (0.578).
- A *different* model, or a new version, gives completely different numbers. **Switch models and you must re-embed everything.**

## Parameters are not dimensions

> *"What is this, 384 numbers per word? … 1 billion parameters or something?"*

| | What it is | For MiniLM |
|---|---|---|
| **Dimensions** | How many numbers come *out* per input | 384 |
| **Parameters** | How many learned numbers are *inside* the model | about 22.7 million |

A parameter is one learned number, like a knob on a mixing desk. About 11.7 million of MiniLM's parameters are a table of 30,522 word pieces × 384 numbers each; the rest are its 6 transformer layers.

The pipeline: split the text into word pieces → look up each piece's row → run 6 layers where every piece looks at the others → **average** all the pieces into one vector → scale it to length 1. That averaging is why a word, a sentence and a paragraph all come out as 384 numbers.

`[CLS]` and `[SEP]` are special tokens added automatically: a start marker and an end or separator marker. Rare words get split into pieces, like `em ##bed ##ding ##s`.

To compare embedding models, check four things: parameters, dimensions, the longest input it takes, and its score on the **MTEB** leaderboard. Bigger isn't automatically better, so start small.

## How the numbers are made: training

> *"For training as well, initially there are about 35,000 numbers. Every number always starts from random numbers, and then it runs models and switches its positions…"*

That's the core idea, and the [explainer](../reference/words-into-numbers.html) shows it with a toy you can run:

1. Every word starts at a **random** point.
2. Read the text. Words that appear in the same sentence are **pulled closer**, and a few random words are **pushed away**.
3. Repeat many times, with smaller steps each time, until the map settles.

In the toy, one "pass" reads all 19 sentences once: 37 word pairs, each pulled together and pushed away from 2 random words. In a real model, an algorithm called backpropagation nudges all 22.7 million numbers at every step, and the weights are frozen after training.

> *"So even though, at any different random numbers, if I start, it will get different numbers, but it will eventually be around it. Is this correct?"*

Almost. The **groups and distances** come out about the same every time: animals together, foods together, cat close to dog. But the **coordinates** differ, and the whole map can come out rotated or mirrored. That's why vectors from two different training runs can't be mixed.

The simulators show this one step at a time, in 2-D and 3-D, with **Previous** and **Next** buttons and a summary of what changed between steps. That was my request: *"I can click one by one, and then it should show me how those paths are working."*

## Dimensions: how many numbers is enough?

- 384 numbers means 384 dimensions. The count comes from the model, not from the word, so every input lives in the same space and can be compared.
- More dimensions give more room to keep meanings apart, but cost storage and speed: about 1.5 KB per vector at 384 dimensions, and about 12 KB at 3,072.
- Today's models top out around 3,000–5,000 dimensions. The usual production range is 768–1,536. Some models (trained "Matryoshka" style) can be cut to fewer dimensions.
- The axes have no names. With 1 dimension, "king" and "pizza" can look identical; similarity settles as you add dimensions.

## Could I build my own?

> *"Can I do it on my 48 GB laptop … M5 Max processor, or does it need NVIDIA and bigger GPUs?"*

Yes, at learning sizes:

| Size | Time on a 48 GB Mac |
|---|---|
| A word2vec-style toy | Minutes to an hour |
| A small transformer, using MLX or PyTorch's Mac (MPS) backend | Hours to days |
| MiniLM quality | Weeks, or rented GPUs |

The hard part is the training data, not the compute. For a real task, **fine-tune** an existing open model on your own (text, label) pairs with `sentence-transformers`. For matching messy job text to an official code list, compare like with like: index past labelled examples instead of only the official descriptions.

## What this changed in the app

In my app, the explainer's toy became real code: each chat is stored as one 384-number vector, a question becomes a point, and Postgres returns the closest chats. That's [memory search step 2](04-search-steps.md).
