-- Procedural memory: how this user wants the assistant to work, learned from what they teach
-- and how they correct replies. Still exactly two tables: it is a column on users.
-- [{id, when, do, createdAt, updatedAt, source: {chatId, via}, previous: [older versions]}]
-- The app role's table-level grants (0002) already cover new columns.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS procedures jsonb NOT NULL DEFAULT '[]';
