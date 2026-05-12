/**
 * llm-credentials-store: CRUD + resolveCredentialForRequest fallback
 * chain. Each test runs against a real Postgres (DATABASE_URL must be
 * set). Tables are truncated before every test via withDb.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "createApiKeyCredential persists encrypted key and returns summary without it",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential } = await import(
        "../../server/shared/utils/llm-credentials-store.ts"
      );
      const u = await seedUser();
      const c = await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        displayName: "Personal",
        apiKey: "sk-ant-original-key",
      });
      assert.equal(c.provider, "anthropic");
      assert.equal(c.mode, "api_key");
      assert.equal(c.hasKey, true);
      assert.equal(c.enabled, true);
      // Importantly: the API key is NOT returned in the summary.
      assert.equal((c as Record<string, unknown>).apiKey, undefined);
    });
  },
);

test(
  "listCredentialsFor scopes results to owner",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential, listCredentialsFor } = await import(
        "../../server/shared/utils/llm-credentials-store.ts"
      );
      const a = await seedUser("owner-a");
      const b = await seedUser("owner-b");
      await createApiKeyCredential({
        ownerKind: "user",
        ownerId: a.id,
        provider: "anthropic",
        displayName: "A's key",
        apiKey: "sk-ant-aaaaaaaa",
      });
      await createApiKeyCredential({
        ownerKind: "user",
        ownerId: b.id,
        provider: "anthropic",
        displayName: "B's key",
        apiKey: "sk-ant-bbbbbbbb",
      });
      const aList = await listCredentialsFor("user", a.id);
      assert.equal(aList.length, 1);
      assert.equal(aList[0]?.displayName, "A's key");
    });
  },
);

test(
  "updateApiKeyCredential rotates the key and re-encrypts it",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createApiKeyCredential,
        updateApiKeyCredential,
        getDecryptedApiKey,
      } = await import("../../server/shared/utils/llm-credentials-store.ts");
      const u = await seedUser();
      const c = await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "openai",
        displayName: "Personal",
        apiKey: "sk-original",
      });
      assert.equal(await getDecryptedApiKey(c.id), "sk-original");

      const updated = await updateApiKeyCredential(c.id, {
        apiKey: "sk-rotated",
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
      });
      assert.ok(updated);
      assert.equal(updated.enabled, false);
      assert.equal(updated.baseUrl, "https://api.openai.com/v1");
      assert.equal(await getDecryptedApiKey(c.id), "sk-rotated");
    });
  },
);

test(
  "deleteCredential removes the row and returns true; second call returns false",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential, deleteCredential } = await import(
        "../../server/shared/utils/llm-credentials-store.ts"
      );
      const u = await seedUser();
      const c = await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "google",
        displayName: "Personal",
        apiKey: "AIza-test-key",
      });
      assert.equal(await deleteCredential(c.id), true);
      assert.equal(await deleteCredential(c.id), false);
    });
  },
);

test(
  "getCredentialOwnedBy enforces owner scope",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential, getCredentialOwnedBy } = await import(
        "../../server/shared/utils/llm-credentials-store.ts"
      );
      const a = await seedUser("a");
      const b = await seedUser("b");
      const c = await createApiKeyCredential({
        ownerKind: "user",
        ownerId: a.id,
        provider: "anthropic",
        displayName: "A",
        apiKey: "sk-ant-aaa",
      });
      assert.ok(await getCredentialOwnedBy(c.id, "user", a.id));
      assert.equal(await getCredentialOwnedBy(c.id, "user", b.id), null);
    });
  },
);

test(
  "resolveCredentialForRequest: user-personal wins over org credential",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential, resolveCredentialForRequest } =
        await import("../../server/shared/utils/llm-credentials-store.ts");
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        displayName: "personal",
        apiKey: "sk-ant-PERSONAL",
      });
      await createApiKeyCredential({
        ownerKind: "org",
        ownerId: org.id,
        provider: "anthropic",
        displayName: "org-shared",
        apiKey: "sk-ant-ORGSHARED",
      });
      const resolved = await resolveCredentialForRequest(
        u.id,
        org.id,
        "anthropic",
      );
      assert.equal(resolved?.apiKey, "sk-ant-PERSONAL");
    });
  },
);

test(
  "resolveCredentialForRequest: falls back to org when user has no credential",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential, resolveCredentialForRequest } =
        await import("../../server/shared/utils/llm-credentials-store.ts");
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      await createApiKeyCredential({
        ownerKind: "org",
        ownerId: org.id,
        provider: "anthropic",
        displayName: "org-shared",
        apiKey: "sk-ant-ORGSHARED",
        baseUrl: "https://proxy.example.com",
      });
      const resolved = await resolveCredentialForRequest(
        u.id,
        org.id,
        "anthropic",
      );
      assert.equal(resolved?.apiKey, "sk-ant-ORGSHARED");
      assert.equal(resolved?.baseUrl, "https://proxy.example.com");
    });
  },
);

test(
  "resolveCredentialForRequest: ignores org if ownerOrgId is null",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential, resolveCredentialForRequest } =
        await import("../../server/shared/utils/llm-credentials-store.ts");
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      await createApiKeyCredential({
        ownerKind: "org",
        ownerId: org.id,
        provider: "anthropic",
        displayName: "org-shared",
        apiKey: "sk-ant-ORGSHARED",
      });
      const resolved = await resolveCredentialForRequest(
        u.id,
        null,
        "anthropic",
      );
      assert.equal(resolved, null);
    });
  },
);

test(
  "resolveCredentialForRequest: skips disabled credentials at both levels",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createApiKeyCredential,
        updateApiKeyCredential,
        resolveCredentialForRequest,
      } = await import("../../server/shared/utils/llm-credentials-store.ts");
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      const personal = await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        displayName: "personal",
        apiKey: "sk-ant-PERSONAL",
      });
      await updateApiKeyCredential(personal.id, { enabled: false });
      const orgCred = await createApiKeyCredential({
        ownerKind: "org",
        ownerId: org.id,
        provider: "anthropic",
        displayName: "org",
        apiKey: "sk-ant-ORG",
      });
      await updateApiKeyCredential(orgCred.id, { enabled: false });

      const resolved = await resolveCredentialForRequest(
        u.id,
        org.id,
        "anthropic",
      );
      assert.equal(resolved, null);
    });
  },
);

test(
  "resolveCredentialForRequest: per-provider isolation",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { createApiKeyCredential, resolveCredentialForRequest } =
        await import("../../server/shared/utils/llm-credentials-store.ts");
      const u = await seedUser();
      await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        displayName: "anthropic only",
        apiKey: "sk-ant-only",
      });
      const a = await resolveCredentialForRequest(u.id, null, "anthropic");
      const b = await resolveCredentialForRequest(u.id, null, "openai");
      assert.equal(a?.apiKey, "sk-ant-only");
      assert.equal(b, null);
    });
  },
);

test(
  "resolveCredentialForRequest: returns oauth_claude shape when an authorized oauth credential exists",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { resolveCredentialForRequest } = await import(
        "../../server/shared/utils/llm-credentials-store.ts"
      );
      const { llmCredentials } = await import("../../server/shared/database/schema.ts");
      const u = await seedUser();
      // No CRUD helper for oauth_claude rows yet (Phase 8 adds the
      // OAuth flow). Insert directly so we can pin Phase 6 resolver
      // behaviour now.
      await db.insert(llmCredentials).values({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        mode: "oauth_claude",
        displayName: "Personal Claude (OAuth)",
        oauthStatus: "authorized",
        oauthAuthorizedAt: new Date(),
        enabled: true,
      });
      const resolved = await resolveCredentialForRequest(
        u.id,
        null,
        "anthropic",
      );
      assert.equal(resolved?.mode, "oauth_claude");
      if (resolved?.mode === "oauth_claude") {
        assert.equal(resolved.ownerKind, "user");
        assert.equal(resolved.ownerId, u.id);
      }
    });
  },
);

test(
  "resolveCredentialForRequest: skips oauth_claude rows that aren't authorized yet",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { resolveCredentialForRequest } = await import(
        "../../server/shared/utils/llm-credentials-store.ts"
      );
      const { llmCredentials } = await import("../../server/shared/database/schema.ts");
      const u = await seedUser();
      await db.insert(llmCredentials).values({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        mode: "oauth_claude",
        displayName: "Pending OAuth",
        oauthStatus: "pending",
        enabled: true,
      });
      const resolved = await resolveCredentialForRequest(
        u.id,
        null,
        "anthropic",
      );
      assert.equal(resolved, null);
    });
  },
);

test(
  "resolveCredentialForRequest: picks the most-recently-updated row of multiple matches",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        createApiKeyCredential,
        updateApiKeyCredential,
        resolveCredentialForRequest,
      } = await import("../../server/shared/utils/llm-credentials-store.ts");
      const u = await seedUser();
      const older = await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        displayName: "older",
        apiKey: "sk-ant-OLDER",
      });
      // Sleep a bit then create the newer one — updatedAt is set on
      // INSERT and on any UPDATE; we want the second insert's timestamp
      // to be strictly later.
      await new Promise((r) => setTimeout(r, 5));
      await createApiKeyCredential({
        ownerKind: "user",
        ownerId: u.id,
        provider: "anthropic",
        displayName: "newer",
        apiKey: "sk-ant-NEWER",
      });
      let resolved = await resolveCredentialForRequest(u.id, null, "anthropic");
      assert.equal(resolved?.apiKey, "sk-ant-NEWER");

      // Touch the older row — it should now win.
      await new Promise((r) => setTimeout(r, 5));
      await updateApiKeyCredential(older.id, { displayName: "older but touched" });
      resolved = await resolveCredentialForRequest(u.id, null, "anthropic");
      assert.equal(resolved?.apiKey, "sk-ant-OLDER");
    });
  },
);
