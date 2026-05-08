import {
  SETTING_KEYS,
  setSetting,
  type RegistrationPolicy,
} from "@su/platform-settings";
import { requirePlatformAdmin } from "@su/platform-admin-auth";

const VALID_POLICIES: RegistrationPolicy[] = ["open", "domain", "closed"];

/**
 * Update platform settings. Body is a partial — only the fields
 * passed are written. All fields are validated upfront before any
 * write so a 400 response never leaves a half-applied state.
 */
export default defineEventHandler(async (event) => {
  const userId = await requirePlatformAdmin(event);

  const body = await readBody<{
    registration?: {
      policy?: string;
      allowedDomains?: string[];
    };
  }>(event);

  let nextPolicy: RegistrationPolicy | undefined;
  let nextAllowedDomains: string[] | undefined;

  if (body?.registration?.policy !== undefined) {
    const policy = body.registration.policy;
    if (!VALID_POLICIES.includes(policy as RegistrationPolicy)) {
      throw createError({
        statusCode: 400,
        statusMessage: `policy must be one of: ${VALID_POLICIES.join(", ")}`,
      });
    }
    nextPolicy = policy as RegistrationPolicy;
  }

  if (body?.registration?.allowedDomains !== undefined) {
    const domains = body.registration.allowedDomains;
    if (!Array.isArray(domains) || !domains.every((d) => typeof d === "string")) {
      throw createError({
        statusCode: 400,
        statusMessage: "allowedDomains must be an array of strings",
      });
    }
    nextAllowedDomains = domains
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  if (nextPolicy !== undefined) {
    await setSetting(SETTING_KEYS.registrationPolicy, nextPolicy, userId);
  }
  if (nextAllowedDomains !== undefined) {
    await setSetting(
      SETTING_KEYS.registrationAllowedDomains,
      nextAllowedDomains,
      userId,
    );
  }

  return { ok: true };
});
