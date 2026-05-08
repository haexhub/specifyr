import { z } from "zod";
import { SETTING_KEYS, setSetting } from "@su/platform-settings";
import { requirePlatformAdmin } from "@su/platform-admin-auth";
import { parseBody } from "@su/validation";

const settingsPatchSchema = z.object({
  registration: z
    .object({
      policy: z.enum(["open", "domain", "closed"]).optional(),
      allowedDomains: z.array(z.string().trim()).optional(),
    })
    .optional(),
});

/**
 * Update platform settings. Body is a partial — only the fields
 * passed are written. Each key is upserted independently so a
 * mid-write failure leaves the others unchanged (within reason; this
 * isn't transactional across keys yet).
 */
export default defineEventHandler(async (event) => {
  const userId = await requirePlatformAdmin(event);
  const body = await parseBody(event, settingsPatchSchema);

  if (body.registration?.policy !== undefined) {
    await setSetting(
      SETTING_KEYS.registrationPolicy,
      body.registration.policy,
      userId,
    );
  }

  if (body.registration?.allowedDomains !== undefined) {
    const normalized = body.registration.allowedDomains
      .map((d) => d.toLowerCase())
      .filter(Boolean);
    await setSetting(
      SETTING_KEYS.registrationAllowedDomains,
      normalized,
      userId,
    );
  }

  return { ok: true };
});
