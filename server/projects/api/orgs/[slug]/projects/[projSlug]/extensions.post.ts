import { z } from "zod";
import { installExtensionsInProject } from "@su/extension-install";
import { assertProjectExists } from "@su/specifyr-stores";
import { parseBody } from "@su/validation";

const installSchema = z
  .object({
    slugs: z.array(z.string().trim().min(1)).optional(),
    slug: z.string().trim().min(1).optional(),
    source: z.enum(["manual", "auto"]).default("manual"),
  })
  .refine(
    (b) => (b.slugs && b.slugs.length > 0) || (typeof b.slug === "string" && b.slug.length > 0),
    { message: "must contain 'slug' or 'slugs'" },
  );

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const projectSlug = event.context.projectSlug!;
  await assertProjectExists(orgId, projectSlug);

  const body = await parseBody(event, installSchema);
  const slugs = body.slugs && body.slugs.length > 0 ? body.slugs : [body.slug!];

  return await installExtensionsInProject(orgId, projectSlug, slugs, body.source);
});
