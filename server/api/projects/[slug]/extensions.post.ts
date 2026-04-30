import { installExtensionsInProject } from "@su/extension-install";
import { assertProjectExists } from "@su/specops-stores";

interface InstallBody {
  slugs?: string[];
  slug?: string;
  source?: "manual" | "auto";
}

export default defineEventHandler(async (event) => {
  const projectSlug = getRouterParam(event, "slug");
  if (!projectSlug) {
    throw createError({ statusCode: 400, statusMessage: "Missing project slug" });
  }
  await assertProjectExists(projectSlug);

  const body = (await readBody(event)) as InstallBody | null;
  const slugs = Array.isArray(body?.slugs)
    ? body!.slugs
    : typeof body?.slug === "string"
      ? [body.slug]
      : [];
  if (slugs.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Body must contain 'slug' or 'slugs'" });
  }

  const source = body?.source === "auto" ? "auto" : "manual";
  return await installExtensionsInProject(projectSlug, slugs, source);
});
