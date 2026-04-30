import path from "node:path";
import { getAppConfigModule } from "#su/app-config";
import { readLocalManifest } from "#su/local-extension";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path?: unknown }>(event);
  const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
  if (!rawPath) {
    throw createError({
      statusCode: 400,
      statusMessage: "Body must contain { path: string }"
    });
  }
  // Resolve relative paths against the app's CWD (where .specops/ lives).
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
