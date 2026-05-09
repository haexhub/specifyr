import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  llmAgentProfiles,
  llmCredentials,
  type LlmAgentProfile,
  type LlmCredential,
} from "../db/schema";
import { decryptString } from "./secrets-store";

export type AgentProfileOwnerKind = "user" | "org";
export type AgentProfilePurpose = "speckit" | "company-agent";
export type AgentProfileProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter";

export type AgentProfileSummary = {
  id: string;
  ownerKind: AgentProfileOwnerKind;
  ownerId: string;
  purpose: AgentProfilePurpose;
  agentRole: string;
  runnerKey: string;
  provider: AgentProfileProvider;
  model: string;
  credentialId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentProfilePatch = {
  runnerKey: string;
  provider: AgentProfileProvider;
  model: string;
  credentialId: string | null;
};

export type RuntimeCredential =
  | {
      mode: "api_key";
      provider: AgentProfileProvider;
      apiKey: string;
      baseUrl: string | null;
    }
  | {
      mode: "oauth_claude";
      provider: "anthropic";
      ownerKind: AgentProfileOwnerKind;
      ownerId: string;
      baseUrl: string | null;
    };

export type ResolvedAgentProfile = AgentProfileSummary & {
  credential: RuntimeCredential;
};

function summarize(row: LlmAgentProfile): AgentProfileSummary {
  return {
    id: row.id,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    purpose: row.purpose,
    agentRole: row.agentRole,
    runnerKey: row.runnerKey,
    provider: row.provider,
    model: row.model,
    credentialId: row.credentialId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function usableCredentialForProfile(
  profile: AgentProfileSummary,
  credential: LlmCredential | null,
): LlmCredential {
  if (!credential) {
    throw new Error("Selected credential does not exist.");
  }
  if (credential.ownerKind !== profile.ownerKind || credential.ownerId !== profile.ownerId) {
    throw new Error("Selected credential belongs to a different owner.");
  }
  if (credential.provider !== profile.provider) {
    throw new Error("Selected credential provider does not match the agent profile provider.");
  }
  if (!credential.enabled) {
    throw new Error("Selected credential is disabled.");
  }
  if (credential.mode === "api_key") {
    if (!credential.apiKeyIv || !credential.apiKeyTag || !credential.apiKeyData) {
      throw new Error("Selected API key credential is incomplete.");
    }
    return credential;
  }
  if (credential.mode === "oauth_claude") {
    if (credential.provider !== "anthropic") {
      throw new Error("OAuth credentials are only supported for Anthropic.");
    }
    if (credential.oauthStatus !== "authorized") {
      throw new Error("Selected Claude OAuth credential is not authorized.");
    }
    return credential;
  }
  throw new Error("Selected credential mode is not supported.");
}

async function getCredential(id: string): Promise<LlmCredential | null> {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(llmCredentials)
    .where(eq(llmCredentials.id, id))
    .limit(1);
  return row ?? null;
}

function normalizeRole(purpose: AgentProfilePurpose, agentRole: string | undefined): string {
  // agent_role is part of the unique key; collapsing nullish/whitespace to ''
  // for speckit profiles is the convention that lets one composite UNIQUE
  // constraint cover both shapes (see migration 0009).
  if (purpose !== "company-agent") return "";
  const value = (agentRole ?? "").trim();
  if (!value) {
    throw new Error("agentRole is required for purpose='company-agent'.");
  }
  return value;
}

export async function getAgentProfileFor(
  ownerKind: AgentProfileOwnerKind,
  ownerId: string,
  purpose: AgentProfilePurpose,
  agentRole: string = "",
): Promise<AgentProfileSummary | null> {
  const db = getDb();
  if (!db) return null;
  const role = normalizeRole(purpose, agentRole);
  const [row] = await db
    .select()
    .from(llmAgentProfiles)
    .where(
      and(
        eq(llmAgentProfiles.ownerKind, ownerKind),
        eq(llmAgentProfiles.ownerId, ownerId),
        eq(llmAgentProfiles.purpose, purpose),
        eq(llmAgentProfiles.agentRole, role),
      ),
    )
    .limit(1);
  return row ? summarize(row) : null;
}

export async function listCompanyAgentProfilesFor(
  ownerKind: AgentProfileOwnerKind,
  ownerId: string,
): Promise<AgentProfileSummary[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(llmAgentProfiles)
    .where(
      and(
        eq(llmAgentProfiles.ownerKind, ownerKind),
        eq(llmAgentProfiles.ownerId, ownerId),
        eq(llmAgentProfiles.purpose, "company-agent"),
      ),
    );
  return rows.map(summarize);
}

export async function upsertAgentProfileFor(
  ownerKind: AgentProfileOwnerKind,
  ownerId: string,
  purpose: AgentProfilePurpose,
  patch: AgentProfilePatch,
  agentRole: string = "",
): Promise<AgentProfileSummary> {
  const db = getDb();
  if (!db) throw new Error("DB not configured");

  const model = patch.model.trim();
  const runnerKey = patch.runnerKey.trim();
  const role = normalizeRole(purpose, agentRole);

  if (purpose === "speckit") {
    if (!runnerKey.startsWith("acp:")) {
      throw new Error("Speckit agent profiles must use an ACP runner.");
    }
    if (runnerKey === "acp:claude" && patch.provider !== "anthropic") {
      throw new Error("Claude ACP profiles must use the Anthropic provider.");
    }
    if (runnerKey === "acp:codex" && patch.provider !== "openai") {
      throw new Error("Codex ACP profiles must use the OpenAI provider.");
    }
  } else if (purpose === "company-agent") {
    if (runnerKey !== "hermes") {
      throw new Error("Company-agent profiles currently only support the 'hermes' runner.");
    }
  } else {
    throw new Error(`Unknown agent profile purpose: ${purpose}`);
  }
  if (!model) throw new Error("Model is required.");

  if (patch.credentialId) {
    const provisional: AgentProfileSummary = {
      id: "",
      ownerKind,
      ownerId,
      purpose,
      agentRole: role,
      runnerKey,
      provider: patch.provider,
      model,
      credentialId: patch.credentialId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    usableCredentialForProfile(provisional, await getCredential(patch.credentialId));
  }

  const now = new Date();
  const [row] = await db
    .insert(llmAgentProfiles)
    .values({
      ownerKind,
      ownerId,
      purpose,
      agentRole: role,
      runnerKey,
      provider: patch.provider,
      model,
      credentialId: patch.credentialId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        llmAgentProfiles.ownerKind,
        llmAgentProfiles.ownerId,
        llmAgentProfiles.purpose,
        llmAgentProfiles.agentRole,
      ],
      set: {
        runnerKey,
        provider: patch.provider,
        model,
        credentialId: patch.credentialId,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("agent profile upsert returned no row");
  return summarize(row);
}

export async function deleteAgentProfileFor(
  ownerKind: AgentProfileOwnerKind,
  ownerId: string,
  purpose: AgentProfilePurpose,
  agentRole: string = "",
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const role = normalizeRole(purpose, agentRole);
  const result = await db
    .delete(llmAgentProfiles)
    .where(
      and(
        eq(llmAgentProfiles.ownerKind, ownerKind),
        eq(llmAgentProfiles.ownerId, ownerId),
        eq(llmAgentProfiles.purpose, purpose),
        eq(llmAgentProfiles.agentRole, role),
      ),
    )
    .returning({ id: llmAgentProfiles.id });
  return result.length > 0;
}

async function resolveProfileCredential(
  profile: AgentProfileSummary,
): Promise<RuntimeCredential> {
  if (!profile.credentialId) {
    throw new Error("Agent profile has no credential selected.");
  }
  const credential = usableCredentialForProfile(
    profile,
    await getCredential(profile.credentialId),
  );
  if (credential.mode === "api_key") {
    return {
      mode: "api_key",
      provider: profile.provider,
      apiKey: await decryptString({
        iv: credential.apiKeyIv!,
        tag: credential.apiKeyTag!,
        data: credential.apiKeyData!,
      }),
      baseUrl: credential.baseUrl,
    };
  }
  return {
    mode: "oauth_claude",
    provider: "anthropic",
    ownerKind: credential.ownerKind,
    ownerId: credential.ownerId,
    baseUrl: credential.baseUrl,
  };
}

async function resolveOwnedProfile(
  ownerKind: AgentProfileOwnerKind,
  ownerId: string,
  purpose: AgentProfilePurpose,
  agentRole: string,
): Promise<ResolvedAgentProfile | null> {
  const profile = await getAgentProfileFor(ownerKind, ownerId, purpose, agentRole);
  if (!profile) return null;
  return { ...profile, credential: await resolveProfileCredential(profile) };
}

export async function resolveAgentProfileForRequest(
  userId: string,
  ownerOrgId: string | null,
  purpose: AgentProfilePurpose,
  agentRole: string = "",
): Promise<ResolvedAgentProfile | null> {
  const role = normalizeRole(purpose, agentRole);
  const personal = await resolveOwnedProfile("user", userId, purpose, role);
  if (personal) return personal;
  if (ownerOrgId) {
    const orgProfile = await resolveOwnedProfile("org", ownerOrgId, purpose, role);
    if (orgProfile) return orgProfile;
  }
  return null;
}
