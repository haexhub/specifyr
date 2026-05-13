-- Dev-only: provisions the `haex_claude_proxy` Postgres role so that
--
--   (a) migrations/0001_grant_claude_proxy_access.sql can attach the
--       table-level GRANTs (the migration silently skips when the role
--       doesn't exist, which would leave the proxy unable to read
--       llm_credentials), and
--
--   (b) the proxy can authenticate as a non-superuser identity, which
--       is the only way the Row-Level-Security policies declared in
--       schema.ts (llm_credentials_proxy_owner_isolation_*) actually
--       fire — table-owner roles like `postgres` bypass RLS implicitly.
--
-- The password here is the dev-only value referenced by the
-- PROXY_DATABASE_URL default in docker-compose.yml. Prod is provisioned
-- by Ansible from secrets.yml.
--
-- Runs once on first postgres init (when the data volume is empty);
-- ignored on subsequent boots. For an existing dev volume, run manually:
--   docker exec specifyr-postgres-dev psql -U postgres -c \
--     "CREATE ROLE haex_claude_proxy LOGIN PASSWORD 'devpw'"
-- and then re-run drizzle-kit migrate to apply the GRANTs.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'haex_claude_proxy') THEN
    CREATE ROLE haex_claude_proxy LOGIN PASSWORD 'devpw';
  END IF;
END
$$;
