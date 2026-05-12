/**
 * runner-sessions-store: mint/lookup/revoke + lifecycle states
 * (expired, revoked, valid). The proxy's threat model depends on
 * lookup correctly rejecting expired/revoked tokens — these tests
 * pin that.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipIfNoDb, withDb, seedUser } from "../helpers/db.ts";

test(
  "mintRunnerSession returns a 64-char hex token + future expiry",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { mintRunnerSession } = await import(
        "../../server/shared/utils/runner-sessions-store.ts"
      );
      const u = await seedUser();
      const minted = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
      });
      assert.match(minted.token, /^[0-9a-f]{64}$/);
      assert.ok(minted.expiresAt.getTime() > Date.now());
    });
  },
);

test(
  "mintRunnerSession respects custom ttlMs",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { mintRunnerSession } = await import(
        "../../server/shared/utils/runner-sessions-store.ts"
      );
      const u = await seedUser();
      const before = Date.now();
      const minted = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
        ttlMs: 5_000,
      });
      const drift = minted.expiresAt.getTime() - before;
      assert.ok(drift >= 5_000 && drift < 6_000, `expected ~5s ttl, got ${drift}ms`);
    });
  },
);

test(
  "lookupRunnerSession returns owner + expiry for a fresh token",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { mintRunnerSession, lookupRunnerSession } = await import(
        "../../server/shared/utils/runner-sessions-store.ts"
      );
      const { createOrgWithAdmin } = await import(
        "../../server/shared/utils/org-store.ts"
      );
      const u = await seedUser();
      const org = await createOrgWithAdmin("Acme", u.id);
      const minted = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "org", id: org.id },
      });
      const resolved = await lookupRunnerSession(minted.token);
      assert.ok(resolved);
      assert.equal(resolved.userId, u.id);
      assert.equal(resolved.owner.kind, "org");
      assert.equal(resolved.owner.id, org.id);
    });
  },
);

test(
  "lookupRunnerSession returns null for an unknown token",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const { lookupRunnerSession } = await import(
        "../../server/shared/utils/runner-sessions-store.ts"
      );
      const r = await lookupRunnerSession("not-a-real-token");
      assert.equal(r, null);
    });
  },
);

test(
  "revokeRunnerSession + lookupRunnerSession returns null",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async () => {
      const {
        mintRunnerSession,
        lookupRunnerSession,
        revokeRunnerSession,
        _findSessionRow,
      } = await import("../../server/shared/utils/runner-sessions-store.ts");
      const u = await seedUser();
      const minted = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
      });
      assert.ok(await lookupRunnerSession(minted.token));
      await revokeRunnerSession(minted.token);
      assert.equal(await lookupRunnerSession(minted.token), null);
      // Soft-delete: row still exists with revoked_at stamped.
      const raw = await _findSessionRow(minted.token);
      assert.ok(raw?.revokedAt instanceof Date);
    });
  },
);

test(
  "lookupRunnerSession rejects expired tokens",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { mintRunnerSession, lookupRunnerSession } = await import(
        "../../server/shared/utils/runner-sessions-store.ts"
      );
      const { runnerSessions } = await import("../../server/shared/database/schema.ts");
      const { eq } = await import("drizzle-orm");
      const u = await seedUser();
      const minted = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
      });
      // Force-expire — only way without faking the clock module-wide.
      await db
        .update(runnerSessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(runnerSessions.token, minted.token));
      assert.equal(await lookupRunnerSession(minted.token), null);
    });
  },
);

test(
  "pruneExpiredRunnerSessions deletes only sufficiently-stale rows",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { mintRunnerSession, pruneExpiredRunnerSessions, _findSessionRow } =
        await import("../../server/shared/utils/runner-sessions-store.ts");
      const { runnerSessions } = await import("../../server/shared/database/schema.ts");
      const { eq } = await import("drizzle-orm");
      const u = await seedUser();

      const fresh = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
      });
      const recentExpired = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
      });
      const longExpired = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
      });
      // recentExpired: expired 1h ago (within 24h grace)
      await db
        .update(runnerSessions)
        .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(runnerSessions.token, recentExpired.token));
      // longExpired: expired 48h ago (outside 24h grace)
      await db
        .update(runnerSessions)
        .set({ expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
        .where(eq(runnerSessions.token, longExpired.token));

      const removed = await pruneExpiredRunnerSessions();
      assert.equal(removed, 1);
      assert.ok(await _findSessionRow(fresh.token));
      assert.ok(await _findSessionRow(recentExpired.token));
      assert.equal(await _findSessionRow(longExpired.token), null);
    });
  },
);

test(
  "deleting the user cascades to their sessions",
  { skip: skipIfNoDb },
  async () => {
    await withDb(async (db) => {
      const { mintRunnerSession, _findSessionRow } = await import(
        "../../server/shared/utils/runner-sessions-store.ts"
      );
      const { users } = await import("../../server/shared/database/schema.ts");
      const { eq } = await import("drizzle-orm");
      const u = await seedUser();
      const minted = await mintRunnerSession({
        userId: u.id,
        owner: { kind: "user", id: u.id },
      });
      await db.delete(users).where(eq(users.id, u.id));
      assert.equal(await _findSessionRow(minted.token), null);
    });
  },
);
