import { and, eq } from "drizzle-orm";
import { getDb } from "../database/client";
import { llmCredentials, type LlmCredential } from "../database/schema";
import { decryptString, encryptString } from "./secrets-store";

/**
 * LLM credential CRUD with at-rest encryption for the api_key field.
 *
 * Resolution-time the runner factory will call resolveCredential() to
 * pick a credential for a given (user, project, provider) tuple. v1
 * implements the simplest of those rules — strict user-personal —
 * org-fallback lands in Phase 5.
 */

export type Provider = "anthropic" | "openai" | "google" | "openrouter";
export type Mode = "api_key" | "oauth_claude";

export type CredentialSummary = {
  id: string;
  ownerKind: "user" | "org";
  ownerId: string;
  provider: Provider;
  mode: Mode;
  displayName: string;
  hasKey: boolean;
  baseUrl: string | null;
  enabled: boolean;
  oauthStatus: "pending" | "authorized" | "expired" | null;
  createdAt: Date;
  updatedAt: Date;
};

function summarize(row: LlmCredential): CredentialSummary {
  return {
    id: row.id,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    provider: row.provider,
    mode: row.mode,
    displayName: row.displayName,
    hasKey: row.mode === "api_key" && !!row.apiKeyData,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    oauthStatus: row.oauthStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listCredentialsFor(
  ownerKind: "user" | "org",
  ownerId: string,
): Promise<CredentialSummary[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(llmCredentials)
    .where(
      and(
        eq(llmCredentials.ownerKind, ownerKind),
        eq(llmCredentials.ownerId, ownerId),
      ),
    );
  return rows.map(summarize);
}

export async function createApiKeyCredential(input: {
  ownerKind: "user" | "org";
  ownerId: string;
  provider: Provider;
  displayName: string;
  apiKey: string;
  baseUrl?: string;
}): Promise<CredentialSummary> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  const enc = await encryptString(input.apiKey);
  const [row] = await db
    .insert(llmCredentials)
    .values({
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      provider: input.provider,
      mode: "api_key",
      displayName: input.displayName,
      apiKeyIv: enc.iv,
      apiKeyTag: enc.tag,
      apiKeyData: enc.data,
      baseUrl: input.baseUrl ?? null,
      enabled: true,
    })
    .returning();
  if (!row) throw new Error("credential insert returned no row");
  return summarize(row);
}

export async function updateApiKeyCredential(
  id: string,
  patch: {
    apiKey?: string;
    displayName?: string;
    baseUrl?: string | null;
    enabled?: boolean;
  },
): Promise<CredentialSummary | null> {
  const db = getDb();
  if (!db) return null;

  const update: Partial<typeof llmCredentials.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.displayName !== undefined) update.displayName = patch.displayName;
  if (patch.baseUrl !== undefined) update.baseUrl = patch.baseUrl;
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.apiKey !== undefined) {
    const enc = await encryptString(patch.apiKey);
    update.apiKeyIv = enc.iv;
    update.apiKeyTag = enc.tag;
    update.apiKeyData = enc.data;
  }

  const [row] = await db
    .update(llmCredentials)
    .set(update)
    .where(eq(llmCredentials.id, id))
    .returning();
  return row ? summarize(row) : null;
}

/**
 * Phase 8: creates a placeholder oauth_claude credential. The actual
 * OAuth token lives on disk under `<credentialsDir>/<owner>/.claude/.credentials.json`
 * (written by the spawned CLI). This row tracks high-level lifecycle
 * (`pending` → `authorized` / `expired`) so the UI can render state
 * and the resolver can decide whether the credential is usable.
 */
export async function createOAuthClaudeCredential(input: {
  ownerKind: "user" | "org";
  ownerId: string;
  displayName: string;
}): Promise<CredentialSummary> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  const [row] = await db
    .insert(llmCredentials)
    .values({
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      provider: "anthropic",
      mode: "oauth_claude",
      displayName: input.displayName,
      oauthStatus: "pending",
      enabled: true,
    })
    .returning();
  if (!row) throw new Error("oauth credential insert returned nothing");
  return summarize(row);
}

/**
 * Phase 8: stamp the credential as fully authorized once the spawned
 * `claude auth login` flow finished and the credentials.json was
 * parsed. authorizedAt is what we'd surface in the UI as "logged in
 * since X" later.
 */
export async function markOAuthAuthorized(
  id: string,
  authorizedAt: Date,
): Promise<CredentialSummary | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .update(llmCredentials)
    .set({
      oauthStatus: "authorized",
      oauthAuthorizedAt: authorizedAt,
      updatedAt: new Date(),
    })
    .where(eq(llmCredentials.id, id))
    .returning();
  return row ? summarize(row) : null;
}

/**
 * Flips an OAuth credential to `expired` — used by the status endpoint
 * when it notices the on-disk credentials file is gone (user wiped it
 * out-of-band, dir got recreated, etc). The DB row still exists so the
 * UI can render "re-auth required" and offer a re-login button.
 */
export async function markOAuthExpired(
  id: string,
): Promise<CredentialSummary | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .update(llmCredentials)
    .set({
      oauthStatus: "expired",
      updatedAt: new Date(),
    })
    .where(eq(llmCredentials.id, id))
    .returning();
  return row ? summarize(row) : null;
}

export async function deleteCredential(id: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const result = await db
    .delete(llmCredentials)
    .where(eq(llmCredentials.id, id))
    .returning({ id: llmCredentials.id });
  return result.length > 0;
}

/**
 * Decrypts and returns the plaintext api key for a credential. Use
 * sparingly — only at runner-factory time when injecting the key into
 * a child env. Never expose via HTTP API.
 */
export async function getDecryptedApiKey(id: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(llmCredentials)
    .where(eq(llmCredentials.id, id))
    .limit(1);
  if (
    !row ||
    row.mode !== "api_key" ||
    !row.apiKeyIv ||
    !row.apiKeyTag ||
    !row.apiKeyData
  ) {
    return null;
  }
  return decryptString({
    iv: row.apiKeyIv,
    tag: row.apiKeyTag,
    data: row.apiKeyData,
  });
}

export async function getCredentialOwnedBy(
  id: string,
  ownerKind: "user" | "org",
  ownerId: string,
): Promise<LlmCredential | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(llmCredentials)
    .where(
      and(
        eq(llmCredentials.id, id),
        eq(llmCredentials.ownerKind, ownerKind),
        eq(llmCredentials.ownerId, ownerId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolved credential — discriminated union so the runner caller knows
 * whether to inject the api key directly or mint a runner session.
 *
 * - `mode: "api_key"`: caller injects ANTHROPIC_API_KEY = apiKey.
 * - `mode: "oauth_claude"`: caller mints a runner_session for the
 *   (ownerKind, ownerId) pair and injects the resulting token as
 *   ANTHROPIC_API_KEY (with the proxy as ANTHROPIC_BASE_URL). The
 *   resolver does NOT mint the token itself — that's a runner-side
 *   concern with its own lifecycle and config (TTL, proxy URL).
 */
export type ResolvedCredential =
  | {
      mode: "api_key";
      apiKey: string;
      baseUrl: string | null;
    }
  | {
      mode: "oauth_claude";
      ownerKind: "user" | "org";
      ownerId: string;
      baseUrl: string | null;
    };

/**
 * Picks the most-recently-updated usable credential for an owner +
 * provider pair. "Usable" = enabled AND
 *   - api_key mode with a stored encrypted key, OR
 *   - oauth_claude mode with oauthStatus='authorized'.
 * If both kinds exist, the more-recently-updated row wins.
 */
async function pickEnabledCredential(
  ownerKind: "user" | "org",
  ownerId: string,
  provider: Provider,
): Promise<ResolvedCredential | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(llmCredentials)
    .where(
      and(
        eq(llmCredentials.ownerKind, ownerKind),
        eq(llmCredentials.ownerId, ownerId),
        eq(llmCredentials.provider, provider),
        eq(llmCredentials.enabled, true),
      ),
    );

  // Filter to actually-usable rows in JS (the SQL OR for the
  // mode/status combo is awkward and Drizzle's where chain stays
  // readable as plain ANDs).
  const usable = rows.filter((r) => {
    if (r.mode === "api_key") {
      return !!(r.apiKeyIv && r.apiKeyTag && r.apiKeyData);
    }
    if (r.mode === "oauth_claude") {
      return r.oauthStatus === "authorized";
    }
    return false;
  });
  if (usable.length === 0) return null;
  usable.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const row = usable[0]!;

  if (row.mode === "api_key") {
    const apiKey = await decryptString({
      iv: row.apiKeyIv!,
      tag: row.apiKeyTag!,
      data: row.apiKeyData!,
    });
    return { mode: "api_key", apiKey, baseUrl: row.baseUrl };
  }
  return {
    mode: "oauth_claude",
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    baseUrl: row.baseUrl,
  };
}

/**
 * User-personal-only resolver, api_key mode only — used by UI previews
 * that need to know "does the user have a key?". Runner code should
 * use {@link resolveCredentialForRequest} instead.
 */
export async function resolveCredentialForUser(
  userId: string,
  provider: Provider,
): Promise<{ apiKey: string; baseUrl: string | null } | null> {
  const hit = await pickEnabledCredential("user", userId, provider);
  if (!hit || hit.mode !== "api_key") return null;
  return { apiKey: hit.apiKey, baseUrl: hit.baseUrl };
}

/**
 * Resolves a usable credential for a given user/project pair. Tries
 * the user's personal credentials first, then falls back to the
 * project's owning org (if any).
 *
 * Resolution order:
 *   1. user-personal enabled credential (api_key OR oauth_claude)
 *   2. project-owner-org enabled credential (when ownerOrgId is set)
 *   3. null (caller falls back to legacy proxy / runtimeConfig)
 */
export async function resolveCredentialForRequest(
  userId: string,
  ownerOrgId: string | null,
  provider: Provider,
): Promise<ResolvedCredential | null> {
  const personal = await pickEnabledCredential("user", userId, provider);
  if (personal) return personal;
  if (ownerOrgId) {
    const orgHit = await pickEnabledCredential("org", ownerOrgId, provider);
    if (orgHit) return orgHit;
  }
  return null;
}
