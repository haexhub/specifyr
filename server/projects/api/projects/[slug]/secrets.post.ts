import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";
import { setSecret } from "@su/secrets-store";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const secretSchema = z.object({
  key: z.string().trim().min(1).max(256),
  value: z.string().min(1),
});

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);
  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  await assertProjectExists(orgId, slug);

  const { key, value } = await parseBody(event, secretSchema);

  await setSecret(orgId, slug, key, value);
  return { ok: true, key };
});
