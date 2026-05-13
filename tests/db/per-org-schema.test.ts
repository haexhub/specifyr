/**
 * Per-org-schema builder tests. Verifies the DDL emitted by
 * createOrgSchema(): 7 tables, partial unique indices, per-org role,
 * append-only grants on secret_access_log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { skipIfNoDb, withDb } from "../helpers/db.ts";
import {
  createOrgSchema,
  orgRoleName,
  orgSchemaName,
} from "../../server/shared/utils/per-org-schema.ts";

const EXPECTED_TABLES = [
  "agent_sessions",
  "agent_spec_secrets",
  "agent_specs",
  "auth_nonces",
  "master_keys",
  "secret_access_log",
  "service_credentials",
];

// Drizzle wraps pg errors in a "Failed query: ..." envelope; the
// original SQLSTATE lives on err.cause. 23505 = unique_violation, 23514
// = check_violation.
function isUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code === "23505";
}
function isCheckViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code === "23514";
}

test("orgSchemaName rejects non-UUID input", () => {
  assert.throws(() => orgSchemaName("not-a-uuid"), /UUID/);
  assert.throws(() => orgSchemaName("'); DROP TABLE orgs--"), /UUID/);
});

test("orgSchemaName replaces dashes with underscores", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(orgSchemaName(id), "org_123e4567_e89b_12d3_a456_426614174000");
  assert.equal(
    orgRoleName(id),
    "org_123e4567_e89b_12d3_a456_426614174000_app",
  );
});

test(
  "createOrgSchema creates the 7 expected tables and the role",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));

      const schema = orgSchemaName(orgId);
      const tableRows = (await db.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${schema} ORDER BY table_name
      `)) as unknown as { rows: Array<{ table_name: string }> };
      assert.deepEqual(
        tableRows.rows.map((r) => r.table_name),
        EXPECTED_TABLES,
      );

      const roleRows = (await db.execute(sql`
        SELECT 1 FROM pg_roles WHERE rolname = ${orgRoleName(orgId)}
      `)) as unknown as { rows: unknown[] };
      assert.equal(roleRows.rows.length, 1);
    });
  },
);

test(
  "secret_access_log grants are SELECT+INSERT only (append-only)",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));

      const role = orgRoleName(orgId);
      const schema = orgSchemaName(orgId);
      const grants = (await db.execute(sql`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = ${role}
          AND table_schema = ${schema}
          AND table_name = 'secret_access_log'
      `)) as unknown as { rows: Array<{ privilege_type: string }> };
      const perms = new Set(grants.rows.map((r) => r.privilege_type));
      assert.ok(perms.has("SELECT"));
      assert.ok(perms.has("INSERT"));
      assert.ok(!perms.has("UPDATE"));
      assert.ok(!perms.has("DELETE"));
    });
  },
);

test(
  "createOrgSchema is idempotent — re-run is a no-op",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));
      // Re-run must not throw and must not change observable state.
      await db.transaction((tx) => createOrgSchema(tx, orgId));

      const schema = orgSchemaName(orgId);
      const tableRows = (await db.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = ${schema} ORDER BY table_name
      `)) as unknown as { rows: Array<{ table_name: string }> };
      assert.deepEqual(
        tableRows.rows.map((r) => r.table_name),
        EXPECTED_TABLES,
      );
    });
  },
);

test(
  "agent_sessions partial unique index enforces one live IP",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));
      const schema = orgSchemaName(orgId);
      // Seed an agent_spec the sessions can FK into
      const specHash = "sha256:test";
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".agent_specs (hash, owner_id, name, version, body)
        VALUES ('${specHash}', '00000000-0000-0000-0000-000000000000', 'test', 1, '{}'::jsonb)
      `));
      // First pending session with IP — OK
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".agent_sessions (spec_hash, container_ip, public_key, status, expires_at)
        VALUES ('${specHash}', '10.20.0.5', 'pubkey1', 'pending', now() + interval '1 hour')
      `));
      // Second pending session with the same IP — must be rejected
      await assert.rejects(
        db.execute(sql.raw(`
          INSERT INTO "${schema}".agent_sessions (spec_hash, container_ip, public_key, status, expires_at)
          VALUES ('${specHash}', '10.20.0.5', 'pubkey2', 'pending', now() + interval '1 hour')
        `)),
        isUniqueViolation,
      );
      // After marking the first as expired, the IP becomes free
      await db.execute(sql.raw(`
        UPDATE "${schema}".agent_sessions SET status = 'expired' WHERE public_key = 'pubkey1'
      `));
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".agent_sessions (spec_hash, container_ip, public_key, status, expires_at)
        VALUES ('${specHash}', '10.20.0.5', 'pubkey3', 'pending', now() + interval '1 hour')
      `));
    });
  },
);

test(
  "agent_spec_secrets CHECK: env mount_mode requires non-empty env_var_name",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));
      const schema = orgSchemaName(orgId);
      const specHash = "sha256:check";
      // Seed FK targets
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".agent_specs (hash, owner_id, name, version, body)
        VALUES ('${specHash}', '00000000-0000-0000-0000-000000000000', 'check', 1, '{}'::jsonb)
      `));
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".master_keys (kek_kid, wrapped_dek, iv, tag)
        VALUES ('kek-check', 'w', 'i', 't')
      `));
      const credId = (
        (await db.execute(sql.raw(`
          INSERT INTO "${schema}".service_credentials (name, owner_id, dek_id, encrypted_value, iv, tag)
          SELECT 'cred-1', '00000000-0000-0000-0000-000000000000', id, 'e', 'i', 't'
            FROM "${schema}".master_keys LIMIT 1
          RETURNING id::text
        `)) as unknown as { rows: Array<{ id: string }> }).rows[0]!.id
      );

      // env mode + NULL env_var_name → rejected
      await assert.rejects(
        db.execute(sql.raw(`
          INSERT INTO "${schema}".agent_spec_secrets (spec_hash, credential_id, mount_mode, env_var_name)
          VALUES ('${specHash}', '${credId}'::uuid, 'env', NULL)
        `)),
        isCheckViolation,
      );
      // env mode + empty env_var_name → rejected
      await assert.rejects(
        db.execute(sql.raw(`
          INSERT INTO "${schema}".agent_spec_secrets (spec_hash, credential_id, mount_mode, env_var_name)
          VALUES ('${specHash}', '${credId}'::uuid, 'env', '')
        `)),
        isCheckViolation,
      );
      // env mode + valid name → accepted
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".agent_spec_secrets (spec_hash, credential_id, mount_mode, env_var_name)
        VALUES ('${specHash}', '${credId}'::uuid, 'env', 'GITHUB_TOKEN')
      `));
      // vault mode with NULL env_var_name → accepted (replaces the env row)
      await db.execute(sql.raw(`
        DELETE FROM "${schema}".agent_spec_secrets WHERE spec_hash = '${specHash}'
      `));
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".agent_spec_secrets (spec_hash, credential_id, mount_mode, env_var_name)
        VALUES ('${specHash}', '${credId}'::uuid, 'vault', NULL)
      `));
    });
  },
);

test(
  "master_keys partial unique index enforces one active row",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const orgId = crypto.randomUUID();
      await db.transaction((tx) => createOrgSchema(tx, orgId));
      const schema = orgSchemaName(orgId);
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".master_keys (kek_kid, wrapped_dek, iv, tag)
        VALUES ('kek-1', 'wrapped1', 'iv1', 'tag1')
      `));
      await assert.rejects(
        db.execute(sql.raw(`
          INSERT INTO "${schema}".master_keys (kek_kid, wrapped_dek, iv, tag, active)
          VALUES ('kek-1', 'wrapped2', 'iv2', 'tag2', true)
        `)),
        isUniqueViolation,
      );
      // Inserting an inactive row alongside the active one is allowed
      await db.execute(sql.raw(`
        INSERT INTO "${schema}".master_keys (kek_kid, wrapped_dek, iv, tag, active)
        VALUES ('kek-1', 'wrapped3', 'iv3', 'tag3', false)
      `));
    });
  },
);
