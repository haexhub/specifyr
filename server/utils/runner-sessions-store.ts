/**
 * runner_sessions store: short-lived bearer tokens injected into agent
 * containers in place of a real Anthropic API key.
 *
 * The token IS the API key from the agent's perspective — hermes
 * forwards it to ANTHROPIC_BASE_URL (the haex-claude-proxy). The proxy
 * resolves the token here, finds the (owner_kind, owner_id), and
 * spawns the `claude` CLI with HOME=<credentials-dir>. See Phase 7.
 *
 * Threat model: anyone holding the token can use the proxy as that
 * owner for the TTL window. We mitigate via:
 *   - short default TTL (1h)
 *   - revoke on demand (revoked_at)
 *   - cascade-delete on user removal
 *   - 32-byte random tokens (collision/guess-resistant)
 *
 * Phase 6 only sets up the table + helpers. The proxy lookup logic
 * (Phase 7) and the ANTHROPIC_API_KEY-as-token wiring in start.post.ts
 * are the consumers.
 */

import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "../db/client";
import { runnerSessions, type RunnerSession } from "../db/schema";

export type SessionOwner = { kind: "user" | "org"; id: string };

export type MintInput = {
  userId: string;
  owner: SessionOwner;
  /** Defaults to 1 hour. */
  ttlMs?: number;
};

export type MintResult = {
  token: string;
  expiresAt: Date;
};

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Creates a fresh session token. The plaintext token is returned — it
 * MUST be propagated to the caller immediately and never re-fetched
 * (we do not encrypt it at rest because the threat model treats DB
 * read access as "game over" anyway, and bcrypt-style hashing breaks
 * the proxy's lookup-by-token query path).
 */
export async function mintRunnerSession(
  input: MintInput,
): Promise<MintResult> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  const token = randomBytes(32).toString("hex");
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await db.insert(runnerSessions).values({
    token,
    userId: input.userId,
    ownerKind: input.owner.kind,
    ownerId: input.owner.id,
    expiresAt,
  });
  return { token, expiresAt };
}

export type ResolvedSession = {
  userId: string;
  owner: SessionOwner;
  expiresAt: Date;
};

/**
 * Looks up a session token. Returns null when:
 *   - the token doesn't exist
 *   - the row is revoked (revoked_at set)
 *   - the row is expired (expires_at <= now)
 *
 * The proxy calls this on every forwarded request. Index on
 * (user_id, expires_at) doesn't help token PK lookups but is useful
 * for the periodic prune query below.
 */
export async function lookupRunnerSession(
  token: string,
): Promise<ResolvedSession | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(runnerSessions)
    .where(eq(runnerSessions.token, token))
    .limit(1);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    userId: row.userId,
    owner: { kind: row.ownerKind, id: row.ownerId },
    expiresAt: row.expiresAt,
  };
}

/**
 * Soft-deletes a session by stamping revoked_at. We don't hard-delete
 * so audit/forensics can correlate "this token was used by X at time
 * T even though it was revoked". The lookupRunnerSession path treats
 * revoked rows the same as missing.
 */
export async function revokeRunnerSession(token: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .update(runnerSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(runnerSessions.token, token), isNull(runnerSessions.revokedAt)),
    );
}

/**
 * Hard-delete every session that has been expired for at least
 * `graceMs` (default 24h). Run on a cron — keeps the table from
 * growing unbounded without losing the recent expired-rows that are
 * still useful for "did this token expire 5 minutes ago" auditing.
 */
export async function pruneExpiredRunnerSessions(
  graceMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - graceMs);
  const result = await db
    .delete(runnerSessions)
    .where(lt(runnerSessions.expiresAt, cutoff))
    .returning({ token: runnerSessions.token });
  return result.length;
}

/**
 * Test-only utility — returns the raw row (including revoked_at /
 * expires_at) so unit tests can introspect lifecycle state. Not
 * exported via the API surface.
 */
export async function _findSessionRow(
  token: string,
): Promise<RunnerSession | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(runnerSessions)
    .where(eq(runnerSessions.token, token))
    .limit(1);
  return row ?? null;
}
