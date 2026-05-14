import {
  SETTING_KEYS,
  type RegistrationPolicy,
} from "@su/platform-settings";
import { getSetting } from "@su/platform-settings";
import { requirePlatformAdmin } from "@su/platform-admin-auth";

/**
 * Returns the current platform settings (registration policy +
 * platform-admin email list). Defaults are baked in here — the
 * absence of a row means "not yet configured" and falls back to the
 * safest default. The env-derived admin list is returned separately
 * so the UI can render it as read-only context.
 */
export default defineEventHandler(async (event) => {
  await requirePlatformAdmin(event);

  const policy = await getSetting<RegistrationPolicy>(
    SETTING_KEYS.registrationPolicy,
    "open",
  );
  const allowedDomains = await getSetting<string[]>(
    SETTING_KEYS.registrationAllowedDomains,
    [],
  );
  const platformAdminEmails = await getSetting<string[]>(
    SETTING_KEYS.platformAdminEmails,
    [],
  );
  const envPlatformAdminEmails = (process.env.SPECIFYR_PLATFORM_ADMIN_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    registration: {
      policy,
      allowedDomains,
    },
    platformAdmins: {
      emails: platformAdminEmails,
      envEmails: envPlatformAdminEmails,
    },
  };
});
