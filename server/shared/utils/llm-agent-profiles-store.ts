import { and, eq } from "drizzle-orm";
import { getDb } from "../database/client";
import {
  llmAgentProfiles,
  llmCredentials,
  type LlmAgentProfile,
  type LlmCredential,
} from "../database/schema";
import { decryptString } from "./secrets-store";
import { ValidationError } from "./validation";

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
      // Carried so the runner can mint a credential-bound runner_session
      // and route the agent through the proxy instead of injecting
      // `apiKey` directly into the container env (closes V2).
      id: string;
      ownerKind: AgentProfileOwnerKind;
      ownerId: string;
      apiKey: string;
      baseUrl: string | null;
    }
  | {
      mode: "oauth_claude";
      provider: "anthropic";
      id: string;
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
    throw new ValidationError("Selected credential does not exist.");
  }
  if (
    credential.ownerKind !== profile.ownerKind ||
    credential.ownerId !== profile.ownerId
  ) {
    throw new ValidationError(
      "Selected credential belongs to a different owner.",
    );
  }
  if (credential.provider !== profile.provider) {
    throw new ValidationError(
      "Selected credential provider does not match the agent profile provider.",
    );
  }
  if (!credential.enabled) {
    throw new ValidationError("Selected credential is disabled.");
  }
  if (credential.mode === "api_key") {
    if (
      !credential.apiKeyIv ||
      !credential.apiKeyTag ||
      !credential.apiKeyData
    ) {
      throw new ValidationError("Selected API key credential is incomplete.");
    }
    return credential;
  }
  if (credential.mode === "oauth_claude") {
    if (credential.provider !== "anthropic") {
      throw new ValidationError(
        "OAuth credentials are only supported for Anthropic.",
      );
    }
    if (credential.oauthStatus !== "authorized") {
      throw new ValidationError(
        "Selected Claude OAuth credential is not authorized.",
      );
    }
    return credential;
  }
  throw new ValidationError("Selected credential mode is not supported.");
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

function normalizeRole(
  purpose: AgentProfilePurpose,
  agentRole: string | undefined,
): string {
  // agent_role is part of the unique key; collapsing nullish/whitespace to ''
  // for speckit profiles is the convention that lets one composite UNIQUE
  // constraint cover both shapes (see migration 0009).
  if (purpose !== "company-agent") return "";
  const value = (agentRole ?? "").trim();
  if (!value) {
    throw new ValidationError(
      "agentRole is required for purpose='company-agent'.",
    );
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
      throw new ValidationError(
        "Speckit agent profiles must use an ACP runner.",
      );
    }
    // Validate by API family, not provider identity. Each ACP agent speaks
    // exactly one wire protocol; any provider that speaks the same protocol
    // (e.g. OpenRouter for OpenAI) can route through it via base-URL override
    // — speckit-agent-runner.ts wires OPENAI_BASE_URL etc. accordingly.
    const ANTHROPIC_COMPATIBLE: AgentProfileProvider[] = ["anthropic"];
    const OPENAI_COMPATIBLE: AgentProfileProvider[] = ["openai", "openrouter"];
    const GOOGLE_COMPATIBLE: AgentProfileProvider[] = ["google"];
    if (
      runnerKey === "acp:claude" &&
      !ANTHROPIC_COMPATIBLE.includes(patch.provider)
    ) {
      throw new ValidationError(
        `Claude ACP profiles require an Anthropic-compatible provider (${ANTHROPIC_COMPATIBLE.join(", ")}).`,
      );
    }
    if (
      runnerKey === "acp:codex" &&
      !OPENAI_COMPATIBLE.includes(patch.provider)
    ) {
      throw new ValidationError(
        `Codex ACP profiles require an OpenAI-compatible provider (${OPENAI_COMPATIBLE.join(", ")}).`,
      );
    }
    if (
      runnerKey === "acp:gemini" &&
      !GOOGLE_COMPATIBLE.includes(patch.provider)
    ) {
      throw new ValidationError(
        `Gemini ACP profiles require a Google-compatible provider (${GOOGLE_COMPATIBLE.join(", ")}).`,
      );
    }
  } else if (purpose === "company-agent") {
    if (runnerKey !== "hermes") {
      throw new ValidationError(
        "Company-agent profiles currently only support the 'hermes' runner.",
      );
    }
  } else {
    throw new ValidationError(`Unknown agent profile purpose: ${purpose}`);
  }
  if (!model) throw new ValidationError("Model is required.");

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
    usableCredentialForProfile(
      provisional,
      await getCredential(patch.credentialId),
    );
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
    throw new ValidationError("Agent profile has no credential selected.");
  }
  const credential = usableCredentialForProfile(
    profile,
    await getCredential(profile.credentialId),
  );
  if (credential.mode === "api_key") {
    return {
      mode: "api_key",
      provider: profile.provider,
      id: credential.id,
      ownerKind: credential.ownerKind,
      ownerId: credential.ownerId,
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
    id: credential.id,
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
  const profile = await getAgentProfileFor(
    ownerKind,
    ownerId,
    purpose,
    agentRole,
  );
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
    const orgProfile = await resolveOwnedProfile(
      "org",
      ownerOrgId,
      purpose,
      role,
    );
    if (orgProfile) return orgProfile;
  }
  return null;
}
