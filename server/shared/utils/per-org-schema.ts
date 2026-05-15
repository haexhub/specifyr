import { sql } from "drizzle-orm";
import type { DbHandle } from "./bridge-subnet-allocator";

// UUID-with-underscores: Postgres identifiers can't contain hyphens
// unquoted. Quoting works but produces uglier names — replacing `-`
// with `_` keeps the schema/role names readable in psql.
export function orgSchemaName(orgId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      orgId,
    )
  ) {
    throw new Error(`invalid org id (not a UUID): ${orgId}`);
  }
  return `org_${orgId.replace(/-/g, "_")}`;
}

export function orgRoleName(orgId: string): string {
  return `${orgSchemaName(orgId)}_app`;
}

/**
 * Creates the per-org Postgres schema (`org_<id>`) with the 7 vault-
 * related tables and the per-org Postgres role with appropriate grants.
 *
 * Idempotent: re-running on an existing schema is a no-op (every
 * statement uses IF NOT EXISTS or guarded DO blocks). Caller is
 * expected to run this inside a transaction so a partial failure rolls
 * back atomically with the surrounding org-create.
 *
 * Phase 1 scope: schema + tables + role + grants. Does NOT generate any
 * crypto material — the `master_keys` table is left empty for the vault
 * daemon to populate via POST /internal/orgs/<id>/init in Phase 3.
 */
export async function createOrgSchema(
  tx: DbHandle,
  orgId: string,
): Promise<void> {
  const schema = orgSchemaName(orgId);
  const role = orgRoleName(orgId);

  // Tables: master_keys first because service_credentials FKs into it.
  const tablesDdl = `
    CREATE SCHEMA IF NOT EXISTS "${schema}";

    CREATE TABLE IF NOT EXISTS "${schema}".master_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kek_kid text NOT NULL,
      wrapped_dek text NOT NULL,
      iv text NOT NULL,
      tag text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      active boolean NOT NULL DEFAULT true
    );
    CREATE UNIQUE INDEX IF NOT EXISTS master_keys_one_active_uq
      ON "${schema}".master_keys (active) WHERE active = true;

    CREATE TABLE IF NOT EXISTS "${schema}".service_credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      owner_id uuid NOT NULL,
      dek_id uuid NOT NULL REFERENCES "${schema}".master_keys(id),
      encrypted_value text NOT NULL,
      iv text NOT NULL,
      tag text NOT NULL,
      rotation_reminder_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS service_credentials_owner_name_uq
      ON "${schema}".service_credentials (owner_id, name);

    CREATE TABLE IF NOT EXISTS "${schema}".agent_specs (
      hash text PRIMARY KEY,
      owner_id uuid NOT NULL,
      name text NOT NULL,
      version integer NOT NULL,
      body jsonb NOT NULL,
      approved_at timestamptz,
      approved_by uuid
    );

    CREATE TABLE IF NOT EXISTS "${schema}".agent_spec_secrets (
      spec_hash text NOT NULL REFERENCES "${schema}".agent_specs(hash),
      credential_id uuid NOT NULL REFERENCES "${schema}".service_credentials(id),
      mount_mode text NOT NULL CHECK (mount_mode IN ('vault', 'env')),
      env_var_name text,
      PRIMARY KEY (spec_hash, credential_id),
      -- length check: '' would pass IS NOT NULL but produces an unusable
      -- env var (POSIX env vars must be non-empty identifiers).
      CHECK (mount_mode <> 'env' OR (env_var_name IS NOT NULL AND length(env_var_name) > 0))
    );

    CREATE TABLE IF NOT EXISTS "${schema}".agent_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      spec_hash text NOT NULL REFERENCES "${schema}".agent_specs(hash),
      container_id text,
      container_ip inet NOT NULL,
      public_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'active', 'expired', 'revoked')),
      jwt_issued_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_one_live_ip_uq
      ON "${schema}".agent_sessions (container_ip)
      WHERE status IN ('pending', 'active');

    CREATE TABLE IF NOT EXISTS "${schema}".auth_nonces (
      nonce text PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES "${schema}".agent_sessions(id),
      expires_at timestamptz NOT NULL,
      redeemed_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS "${schema}".secret_access_log (
      id bigserial PRIMARY KEY,
      session_id uuid NOT NULL,
      spec_hash text NOT NULL,
      event text NOT NULL CHECK (event IN ('challenge', 'token_mint', 'secret_read', 'egress_connect', 'egress_denied')),
      target text,
      granted boolean NOT NULL,
      ip inet,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );

    -- User-defined secrets injected into agent containers at start.
    -- Encrypted with AES-256-GCM using SPECIFYR_SECRET_KEY (same master
    -- key as llm_credentials / org_extensions). The (iv, tag, ciphertext)
    -- triple matches the format produced by secrets-store.ts so the
    -- encrypted blob is a verbatim copy of the legacy on-disk format.
    -- Org-scope: key is unique within the org.
    CREATE TABLE IF NOT EXISTS "${schema}".org_secrets (
      key text PRIMARY KEY,
      iv text NOT NULL,
      tag text NOT NULL,
      encrypted_value text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Project-scope: same shape, keyed by (project_slug, key). The slug
    -- (not the project UUID) matches the on-disk artifact directory and
    -- avoids a cross-schema FK to the global projects table — cleanup
    -- on project-delete is handled at the application layer.
    CREATE TABLE IF NOT EXISTS "${schema}".project_secrets (
      project_slug text NOT NULL,
      key text NOT NULL,
      iv text NOT NULL,
      tag text NOT NULL,
      encrypted_value text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_slug, key)
    );
  `;
  await tx.execute(sql.raw(tablesDdl));

  // CREATE ROLE lacks IF NOT EXISTS — guard with a DO block. GRANTs are
  // intrinsically idempotent in Postgres so they can be replayed safely.
  const roleDdl = `
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE "${role}";
      END IF;
    END
    $do$;

    GRANT USAGE ON SCHEMA "${schema}" TO "${role}";

    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".service_credentials TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".agent_specs TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".agent_spec_secrets TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".agent_sessions TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".master_keys TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".auth_nonces TO "${role}";

    -- secret_access_log: append-only audit. No UPDATE / DELETE for the
    -- per-org role. bigserial generates an implicit sequence; the role
    -- needs USAGE on it to INSERT.
    GRANT SELECT, INSERT ON "${schema}".secret_access_log TO "${role}";
    GRANT USAGE ON SEQUENCE "${schema}".secret_access_log_id_seq TO "${role}";

    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".org_secrets TO "${role}";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}".project_secrets TO "${role}";
  `;
  await tx.execute(sql.raw(roleDdl));
}
