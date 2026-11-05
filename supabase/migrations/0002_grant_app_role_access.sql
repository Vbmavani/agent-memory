-- The app connects with its own login, agent_memory_app, which only has row access to the two
-- tables (no DDL, no other schemas). Create the role first, with a password that is never stored
-- in this repo, e.g.:
--   CREATE ROLE agent_memory_app LOGIN NOINHERIT CONNECTION LIMIT 10 PASSWORD '<scram-sha-256 verifier>';
-- and save the connection string (session pooler, user agent_memory_app.<project-ref>) in the
-- macOS Keychain entry "agent-memory-database-url".
GRANT USAGE ON SCHEMA public TO agent_memory_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.chats TO agent_memory_app;

-- RLS stays ON for everyone else; only the app's role gets through.
CREATE POLICY app_full_access ON public.users FOR ALL TO agent_memory_app USING (true) WITH CHECK (true);
CREATE POLICY app_full_access ON public.chats FOR ALL TO agent_memory_app USING (true) WITH CHECK (true);
