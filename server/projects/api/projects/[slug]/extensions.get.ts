import path from "node:path";
import fs from "node:fs/promises";
import { projectArtifactsDir } from "@su/data-dirs";
import { projectCwd } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";

interface ExtensionInstallRecord {
  slug: string;
  installedAt: string;
  source: "auto" | "manual";
  status: "installed" | "failed";
  message?: string;
}

interface ExtensionsManifest {
  slug: string;
  extensions: ExtensionInstallRecord[];
  updatedAt: string | null;
}

interface SpecKitRegistry {
  extensions: Record<string, { enabled: boolean; version: string; installed_at?: string }>;
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);

  // Primary source: specifyr's own manifest written by installExtensionsInProject.
  const manifestPath = path.join(projectArtifactsDir(orgId, slug), "extensions.json");
  try {
    const content = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(content) as ExtensionsManifest;
    if (manifest.extensions.some((e) => e.status === "installed")) {
      return manifest;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    // ENOENT: fall through to spec-kit registry
  }

  // Fallback: spec-kit's own .registry (authoritative source for what's physically installed).
  // This covers projects created or extensions installed directly via the specify CLI without
  // going through specifyr's installExtensionsInProject.
  const registryPath = path.join(projectCwd(orgId, slug), ".specify", "extensions", ".registry");
  try {
    const content = await fs.readFile(registryPath, "utf8");
    const registry = JSON.parse(content) as SpecKitRegistry;
    const extensions: ExtensionInstallRecord[] = Object.entries(registry.extensions)
      .filter(([, ext]) => ext.enabled)
      .map(([extSlug, ext]) => ({
        slug: extSlug,
        installedAt: ext.installed_at ?? new Date().toISOString(),
        source: "auto" as const,
        status: "installed" as const
      }));
    return { slug, extensions, updatedAt: null } as ExtensionsManifest;
  } catch {
    return { slug, extensions: [], updatedAt: null } as ExtensionsManifest;
  }
});
