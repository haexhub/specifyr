-- Bootstrap database + role for Authentik (dev only).
--
-- Mirrors roles/authentik/tasks/main.yml in the ansible deployment, where the
-- authentik role is least-privilege: it owns its own database but has no
-- rights on the cluster otherwise. We do the same here in dev so the dev
-- topology matches prod.
--
-- Runs once on first postgres init (empty data volume).
-- Password is dev-only — never reuse outside localhost.
CREATE ROLE authentik LOGIN PASSWORD 'authentikpw';
CREATE DATABASE authentik OWNER authentik;
