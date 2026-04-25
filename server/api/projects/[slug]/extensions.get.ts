import path from "node:path";
import fs from "node:fs/promises";

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

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const manifestPath = path.join(process.cwd(), ".specops", slug, "extensions.json");
  try {
    const content = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(content) as ExtensionsManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { slug, extensions: [], updatedAt: null } as ExtensionsManifest;
    }
    throw err;
  }
});
