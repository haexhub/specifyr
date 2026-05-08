import { z } from "zod";
import { requireOrgPermission } from "@su/org-auth";
import { addOrgExtension } from "@su/org-extensions-store";
import { parseBody } from "@su/validation";

const bodySchema = z.object({
  sourceUrl: z.string().trim().url().max(2048),
  sourceRef: z.string().trim().min(1).max(256).nullable().optional(),
  credentials: z
    .object({
      username: z.string().trim().min(1).max(256),
      token: z.string().trim().min(1).max(4096),
    })
    .nullable()
    .optional(),
});

/**
 * Add a new org-scoped extension by cloning a Git repo. Caller must be
 * an org admin OR hold the `manage_extensions` permission. Slug is
 * derived from the cloned extension.yml (extension.id), never from
 * user input.
 *
 * Errors map:
 *   400 url_invalid       — non-https or blocked host
 *   400 manifest_invalid  — clone succeeded but extension.yml missing/broken
 *   409 slug_conflict     — slug already registered for this org
 *   422 quota_exceeded    — org hit MAX_EXTENSIONS_PER_ORG
 *   502 clone_failed      — git itself failed (auth, network, ref not found)
 */
export default defineEventHandler(async (event) => {
  const { org, userId } = await requireOrgPermission(event, "manage_extensions");
  const body = await parseBody(event, bodySchema);

  const result = await addOrgExtension({
    orgId: org.id,
    sourceUrl: body.sourceUrl,
    sourceRef: body.sourceRef ?? null,
    credentials: body.credentials ?? null,
    registeredBy: userId,
  });

  if (!result.ok) {
    const status =
      result.reason === "url_invalid" || result.reason === "manifest_invalid"
        ? 400
        : result.reason === "slug_conflict"
          ? 409
          : result.reason === "quota_exceeded"
            ? 422
            : 502;
    throw createError({
      statusCode: status,
      statusMessage: result.message,
      data: { reason: result.reason },
    });
  }
  return { extension: result.extension };
});
