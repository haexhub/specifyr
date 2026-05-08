import {
  SETTING_KEYS,
  setSetting,
  type RegistrationPolicy,
} from "@su/platform-settings";
import { requirePlatformAdmin } from "@su/platform-admin-auth";

const VALID_POLICIES: RegistrationPolicy[] = ["open", "domain", "closed"];

/**
 * Update platform settings. Body is a partial — only the fields
 * passed are written. Each key is upserted independently so a
 * mid-write failure leaves the others unchanged (within reason; this
 * isn't transactional across keys yet).
 */
export default defineEventHandler(async (event) => {
  const userId = await requirePlatformAdmin(event);

  const body = await readBody<{
    registration?: {
      policy?: string;
      allowedDomains?: string[];
    };
  }>(event);

  if (body?.registration?.policy !== undefined) {
    const policy = body.registration.policy;
    if (!VALID_POLICIES.includes(policy as RegistrationPolicy)) {
      throw createError({
        statusCode: 400,
        statusMessage: `policy must be one of: ${VALID_POLICIES.join(", ")}`,
      });
    }
    await setSetting(SETTING_KEYS.registrationPolicy, policy, userId);
  }

  if (body?.registration?.allowedDomains !== undefined) {
    const domains = body.registration.allowedDomains;
    if (!Array.isArray(domains) || !domains.every((d) => typeof d === "string")) {
      throw createError({
        statusCode: 400,
        statusMessage: "allowedDomains must be an array of strings",
      });
    }
    const normalized = domains
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    await setSetting(
      SETTING_KEYS.registrationAllowedDomains,
      normalized,
      userId,
    );
  }

  return { ok: true };
});
