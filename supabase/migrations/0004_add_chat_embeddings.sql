-- Step 2 of past-chat search: search by MEANING, not only by words.
-- Each chat gets one embedding: 384 numbers that describe what the chat is about (computed in
-- server/embed.js by a small local model). Similar chats have nearby points, so a question finds a
-- chat even when they share no words ("team sync" finds a chat about a "standup").
-- Still exactly two tables: the vector is a column on chats.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS embedding extensions.vector(384);

-- HNSW: an index for "closest points first" with cosine distance (the <=> operator).
CREATE INDEX IF NOT EXISTS chats_embedding_idx
  ON public.chats USING hnsw (embedding extensions.vector_cosine_ops);

-- The app's login needs to see the vector type and operators (the app sets search_path to
-- "public, extensions" on every connection).
GRANT USAGE ON SCHEMA extensions TO agent_memory_app;
