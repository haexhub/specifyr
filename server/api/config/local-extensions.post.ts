import path from "node:path";
import { z } from "zod";
import { getAppConfigModule } from "@su/app-config";
import { readLocalManifest } from "@su/local-extension";
import { parseBody } from "@su/validation";
import { requirePlatformAdmin } from "@su/platform-admin-auth";

const bodySchema = z.object({
  path: z.string().trim().min(1).max(4096),
});

// Deployment-global registration: writes the entry to the shared
// app-config and is therefore platform-admin-only. Per-org extensions
// go through /api/orgs/:slug/extensions instead.
export default defineEventHandler(async (event) => {
  await requirePlatformAdmin(event);
  const { path: rawPath } = await parseBody(event, bodySchema);
  // Resolve relative paths against the app's CWD (where .specifyr/ lives).
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);

  // Parse the manifest; this validates the path is a dir, extension.yml exists and is
  // well-formed, and extracts the authoritative slug. We do NOT accept a user-supplied slug.
  let parsed;
  try {
    parsed = await readLocalManifest(resolved);
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: `invalid extension: ${(err as Error).message}`
    });
  }

  const { loadAppConfig, addLocalExtension } = await getAppConfigModule();
  const cfg = await loadAppConfig();
  if ((cfg.localExtensions ?? []).some((e) => e.slug === parsed.slug)) {
    throw createError({
      statusCode: 409,
      statusMessage: `local extension '${parsed.slug}' is already registered`
    });
  }

  try {
    const entry = await addLocalExtension({ slug: parsed.slug, path: resolved });
    return { extension: { ...entry, ...parsed } };
  } catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: (err as Error).message
    });
  }
});
