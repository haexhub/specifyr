import {
  SETTING_KEYS,
  type RegistrationPolicy,
} from "@su/platform-settings";
import { getSetting } from "@su/platform-settings";
import { requirePlatformAdmin } from "@su/platform-admin-auth";

/**
 * Returns the current platform settings (currently just registration
 * policy). Defaults are baked in here — the absence of a row means
 * "not yet configured" and falls back to the safest default.
 */
export default defineEventHandler(async (event) => {
  await requirePlatformAdmin(event);

  // Safest default when no row is configured: "closed". Admins must
  // explicitly opt the platform into self-registration.
  const policy = await getSetting<RegistrationPolicy>(
    SETTING_KEYS.registrationPolicy,
    "closed",
  );
  const allowedDomains = await getSetting<string[]>(
    SETTING_KEYS.registrationAllowedDomains,
    [],
  );

  return {
    registration: {
      policy,
      allowedDomains,
    },
  };
});
