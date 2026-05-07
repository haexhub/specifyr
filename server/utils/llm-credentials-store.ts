import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { llmCredentials, type LlmCredential } from "../db/schema";
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
  if (!row || row.mode !== "api_key" || !row.apiKeyIv || !row.apiKeyTag || !row.apiKeyData) {
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

export type ResolvedCredential = {
  apiKey: string;
  baseUrl: string | null;
};

/**
 * Resolves a usable credential for a given user + provider, returning
 * the decrypted key + optional baseUrl. Used by the runner factory at
 * agent-spawn time to inject env vars into worker containers.
 *
 * v1 (Phase 4) walks user-personal credentials only. Phase 5 will add
 * org-fallback once project ownership wires through to a resolvable
 * org id. Multiple personal credentials of the same provider: picks
 * the most-recently-updated enabled api_key entry — minimal
 * "default" behaviour, can be sharpened to a user-pickable default
 * later if needed.
 */
export async function resolveCredentialForUser(
  userId: string,
  provider: Provider,
): Promise<ResolvedCredential | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(llmCredentials)
    .where(
      and(
        eq(llmCredentials.ownerKind, "user"),
        eq(llmCredentials.ownerId, userId),
        eq(llmCredentials.provider, provider),
        eq(llmCredentials.mode, "api_key"),
        eq(llmCredentials.enabled, true),
      ),
    );

  if (rows.length === 0) return null;
  // Sort in JS to avoid pulling another column into the query plan;
  // the result set is per-user so it's tiny in practice.
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const row = rows[0];
  if (!row.apiKeyIv || !row.apiKeyTag || !row.apiKeyData) return null;
  const apiKey = await decryptString({
    iv: row.apiKeyIv,
    tag: row.apiKeyTag,
    data: row.apiKeyData,
  });
  return { apiKey, baseUrl: row.baseUrl };
}
