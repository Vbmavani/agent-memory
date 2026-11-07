-- Graph memory: how people, places and things in the user's life are connected, as edges
-- [{id, from, fromKey, rel, to, toKey, since, until, source}]. Stored as one jsonb column on users,
-- so the app still has exactly two tables. Postgres walks it with WITH RECURSIVE (see server/db.js).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS edges jsonb NOT NULL DEFAULT '[]';
