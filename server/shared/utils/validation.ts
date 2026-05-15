import { z, ZodError } from "zod";

/**
 * Shared schemas + thin parsing helpers.
 *
 * h3's `getValidatedQuery` etc. wrap any thrown error in their own
 * 400 envelope, which would nest our issues under `data.data.issues`.
 * We use plain `getQuery`/`readBody` and validate explicitly so the
 * 400 response is exactly what we throw.
 *
 * The event parameter is typed as Parameters<typeof getQuery>[0] —
 * H3Event is auto-imported as a global in Nitro, but vue-tsc against
 * the client tsconfig can't resolve a `from "h3"` import.
 */

type H3Event = Parameters<typeof getQuery>[0];

function toBadRequest(error: ZodError): never {
  throw createError({
    statusCode: 400,
    statusMessage: "Invalid input",
    data: {
      issues: error.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
    },
  });
}

export function parseQuery<T>(event: H3Event, schema: z.ZodType<T>): T {
  const result = schema.safeParse(getQuery(event));
  if (!result.success) toBadRequest(result.error);
  return result.data;
}

export async function parseBody<T>(
  event: H3Event,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = await readBody(event).catch(() => null);
  const result = schema.safeParse(body);
  if (!result.success) toBadRequest(result.error);
  return result.data;
}

export function parseParams<T>(event: H3Event, schema: z.ZodType<T>): T {
  const result = schema.safeParse(event.context.params ?? {});
  if (!result.success) toBadRequest(result.error);
  return result.data;
}

/**
 * Sentinel for domain-level validation errors thrown from store/service code.
 *
 * Route handlers catch these and map them to a 400 with the original message
 * (user-facing reasons like "Selected credential is disabled."), while any
 * other error class is treated as a server fault: logged and surfaced as a
 * generic 500 so internals (DB driver messages, stack hints) don't leak.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/* ---------- shared schemas ---------- */

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const slugString = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);

export const orgSlugParam = z.object({ slug: slugString });
export const projectSlugParam = z.object({ slug: slugString });

export const userIdParam = z.object({ userId: z.uuid() });
export const idParam = z.object({ id: z.string().min(1) });
export const idUuidParam = z.object({ id: z.uuid() });
export const tokenParam = z.object({ token: z.string().min(1).max(256) });

export const stepParams = z.object({
  projSlug: slugString,
  stepId: z.string().min(1).max(128),
});

export const sessionParams = z.object({
  projSlug: slugString,
  stepId: z.string().min(1).max(128),
  sid: z.string().min(1).max(128),
});

export const taskIdParams = z.object({
  projSlug: slugString,
  tid: z.string().min(1).max(256),
});

export const projectExtensionParams = z.object({
  projSlug: slugString,
  extSlug: z.string().min(1).max(128),
});

export const orgExtensionParams = z.object({
  slug: slugString,
  extSlug: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/),
});

export const orgPermissionParams = z.object({
  slug: slugString,
  userId: z.uuid(),
  permission: z.enum(["manage_extensions"]),
});

export const projectSecretParams = z.object({
  projSlug: slugString,
  key: z.string().min(1).max(256),
});

export const orgMemberParams = z.object({
  slug: slugString,
  userId: z.uuid(),
});

export const orgCredentialParams = z.object({
  slug: slugString,
  id: z.uuid(),
});

const PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const;
const ACP_RUNNERS = ["acp:claude", "acp:codex", "acp:gemini"] as const;
const COMPANY_AGENT_RUNNERS = ["hermes"] as const;

// Locale codes the app's i18n bundle ships with. Kept in sync with
// nuxt.config.ts `i18n.locales[]` codes — server-side validation must
// reject anything the client can't actually load.
export const SUPPORTED_LOCALES = ["de", "en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// Trim, then collapse empty string to null so clearing the field falls
// back to whatever the IDP last provided. Cap at 120 chars to match the
// users.display_name DB usage downstream.
export const mePatchSchema = z.object({
  displayName: z
    .string()
    .max(120)
    .transform((v) => v.trim())
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional(),
  preferredLocale: z.enum(SUPPORTED_LOCALES).nullable().optional(),
});

export type MePatchInput = z.infer<typeof mePatchSchema>;

export const llmCredentialCreateSchema = z.object({
  provider: z.enum(PROVIDERS),
  displayName: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(8).max(4096),
  baseUrl: z.string().trim().min(1).max(512).optional(),
});

export const llmCredentialPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().trim().min(8).max(4096).optional(),
  baseUrl: z.string().trim().min(1).max(512).nullable().optional(),
  enabled: z.boolean().optional(),
});

export const oauthCodeSchema = z.object({
  code: z.string().trim().min(4).max(4096),
});

export const speckitAgentProfileSchema = z.object({
  runnerKey: z.enum(ACP_RUNNERS),
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1).max(200),
  credentialId: z.uuid().nullable(),
});

// Agent role identifier — must match the role declared in the agent's
// .specify/org/agents/<role>.md spec. We accept the same shape spec-kit
// uses (lowercase letters, digits, dashes, underscores) and cap the
// length so we don't accidentally allow path-traversal-y values.
const agentRoleString = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/);

export const companyAgentProfileSchema = z.object({
  runnerKey: z.enum(COMPANY_AGENT_RUNNERS),
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1).max(200),
  credentialId: z.uuid().nullable(),
});

export const companyAgentRoleParam = z.object({
  projSlug: slugString,
  role: agentRoleString,
});

export const orgCompanyAgentRoleParam = z.object({
  slug: slugString,
  role: agentRoleString,
});

export type LlmCredentialCreateInput = z.infer<typeof llmCredentialCreateSchema>;
export type LlmCredentialPatchInput = z.infer<typeof llmCredentialPatchSchema>;
export type SpeckitAgentProfileInput = z.infer<typeof speckitAgentProfileSchema>;
export type CompanyAgentProfileInput = z.infer<typeof companyAgentProfileSchema>;
