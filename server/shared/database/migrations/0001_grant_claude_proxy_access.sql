-- Least-privilege GRANTs für haex-claude-proxy auf die specifyr-Tabellen,
-- die der Proxy zur Laufzeit liest/aktualisiert. Hintergrund:
--
--   * Der Proxy bringt eine eigene Postgres-Rolle `haex_claude_proxy` mit,
--     die per Ansible (CREATE ROLE + Passwort) angelegt wird. Lifecycle
--     der Rolle bleibt dort, weil das Passwort aus secrets.yml kommt.
--   * Die *Rechte* der Rolle wandern hierher, damit Schema-Änderung +
--     zugehörige GRANTs atomar in derselben Migration rausgehen — kein
--     "Ansible-Re-Run nach Migration vergessen"-Footgun mehr (siehe
--     historischer Fehler: GRANT UPDATE auf oauth_credentials_iv lief vor
--     dem Migrieren der Spalte und schlug fehl).
--   * Wenn die Rolle (z.B. in lokalen dev/test-DBs) nicht existiert,
--     überspringen wir die GRANTs still — der Proxy läuft eh nicht
--     dagegen, und Drizzle-Migrationen sollen in jedem Setup grün sein.
--
-- Mengenumfang spiegelt das auth/refresh-Verhalten in haex-claude-proxy
-- (src/auth.js + src/credentials.js):
--   * runner_sessions: nur SELECT (Token-Lookup beim Spawn).
--   * llm_credentials: SELECT auf alle Spalten (entry-resolve) + UPDATE
--     auf die OAuth-Credential-Spalten (Token-Refresh schreibt zurück).
--     Kein UPDATE auf api_key_* / Owner-Felder — die ändert nur specifyr.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'haex_claude_proxy') THEN
    RAISE NOTICE 'Skipping GRANTs: role "haex_claude_proxy" does not exist (provision via ansible first)';
    RETURN;
  END IF;

  EXECUTE 'GRANT CONNECT ON DATABASE ' || quote_ident(current_database()) || ' TO haex_claude_proxy';
  GRANT USAGE ON SCHEMA public TO haex_claude_proxy;
  GRANT SELECT ON TABLE public.runner_sessions TO haex_claude_proxy;
  GRANT SELECT ON TABLE public.llm_credentials TO haex_claude_proxy;
  GRANT UPDATE (
    oauth_credentials_iv,
    oauth_credentials_tag,
    oauth_credentials_data,
    oauth_expires_at,
    updated_at
  ) ON TABLE public.llm_credentials TO haex_claude_proxy;
END
$$;
