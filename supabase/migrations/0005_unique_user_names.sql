-- Several users: you log in by typing a username (users.name), so names must be unique,
-- ignoring upper/lower case ("Alex" and "alex" are the same user). Still exactly two tables.
CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON public.users (lower(name));
