# 6. My thinking process

Looking back over the sessions, the same habits show up again and again. They're why four days was enough. Each one is shown with what I actually typed.

## 1. Get the whole map before going deep

> *"Okay can you give me how many components of agent?"*
> *"I want to learn about all types of memory… It should be in detail, so I will take it one by one."*

I chose the next topic from a complete list, not from whatever came up first. Every later question had a place to land.

## 2. Bring my own model, and fix it

> *"what about this? You didn't add hooks. I already learned about hooks"*

I came with my own picture of an agent as a body. I pushed back when the list didn't match it, and asked for the new ideas to be *connected to it* instead of starting over.

## 3. Name the concept to check it

> *"That would be kind of episodic memory, right?"*
> *"procedural memory can be similar to skill?"*

Guessing the name out loud is a quick test: either it's confirmed, or I find out exactly where my picture is wrong.

## 4. Anchor new ideas to things I already know

> *"I always think from database perspective"*
> *"so kinda opensearch where it sometimes provides weights on search..."*
> *"I can give you an example of Claude Haiku, Claude Sonnet, Claude Opus, and Claude Fable"*

Databases, OpenSearch, Skills and Claude's model names were my handholds. When an analogy was wrong (search weights aren't model weights), finding out *why* taught me the real idea.

## 5. Ask for the mechanism, not just the result

> *"I think it is working, but I don't know how it's working."*
> *"which tool it is using for this particular task and how it is done at the code level."*

A feature working in the UI wasn't enough. I kept asking until I could say which call does what, and why.

## 6. Restate it in my own words

> *"The chat AI model is just writing temporarily in the object or something, right?"*
> *"So, the word dropping happens on Postgres only, right?"*
> *"Every number always starts from random numbers, and then it runs models and switches its positions…"*

Saying it back is how I find the half that's wrong.

## 7. Question the design before accepting it

> *"or is there any way that you're doing it on purpose? First let me know why you run two AI model chats?"*

I don't take a design as given. Asking why there were two model calls led to the hybrid design, and then to the single writer.

## 8. Test in the UI, bring back real bugs

> *"Here the problem is: … the manual one created new history … but the automatic one updated the existing history … So how to solve this problem."*

The most important bug of the whole build (two writers, two facts) came from using the app, not from reading code.

## 9. Look at the data where it lives

> *"Can you open a Postgres database? I want to see how data is stored..."*
> *"Tell me, in the database, where you store it and how you store it. And when do you store it?"*

Seeing one fact per row, and one vector column per chat, made the abstractions real.

## 10. Probe for ground truth

> *"The data should be accurate, like the numbers. Every time I embed 'king', will it get the exact same embed?"*
> *"So even though, at any different random numbers, if I start, it will get different numbers, but it will eventually be around it. Is this correct?"*

I wanted real numbers from a real model, and I kept pushing on whether a result was stable or just a coincidence.

## 11. When stuck, go back to zero, with pictures I can step through

> *"I'm still not able to understand this… from scratch, from zero, the basics"*
> *"I can click one by one… it should have the previous step and next step, and it should have the summary of what it did"*

When an explanation didn't land, I asked for a visual from the very beginning, and then for simulators I could step through: 2-D, then 3-D, then 4-D, then 384 dimensions.

## 12. Use artifacts for structure and chat for questions

> *"give it to me in the same formats… over here, so that I can ask the question in the side state, which I can't do on the artifact"*

An artifact is good for the big picture. Chat is where I can quote one line and ask about it. I used both, twice.

## 13. Ground it in my own setup

> *"can i know the system prompts?"* · *"what's currently there? can you open system claude.md fiel?"* · *"Can I do it on my 48 GB laptop…?"*

Learning sticks when it's about my own files, my own tools and my own machine.

## 14. Keep it safe, and make it shareable

> *"Make sure you're not pushing any kind of key or any sensitive data."*
> *"if you're learning start from first step that search using SQL… and then next step try this embedding search"*

Every push was checked for secrets first. And I kept shaping the work into a path someone else could follow: step 1 kept in its own file, this site, and step 3 (mem0) named before I start it.
