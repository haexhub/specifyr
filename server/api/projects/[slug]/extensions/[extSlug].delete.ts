import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dataDir } from "@su/data-dirs";
import { projectCwd, loadEventStore } from "@su/specops-stores";

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

async function loadRunCommand() {
  const url = pathToFileURL(path.join(process.cwd(), "src/utils/process.js")).href;
  return (await import(url)) as {
    runCommand: (
      cmd: string,
      args: string[],
      opts?: { cwd?: string; input?: string }
    ) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>;
  };
}

// Remove an entry from .specify/extensions/.registry. Idempotent: missing file, missing
// extensions-block, or missing entry are all treated as "nothing to do". A malformed
// registry is reported back so the caller can surface it in the event log — we do NOT
// overwrite a file we failed to parse.
async function removeFromRegistry(
  projectSlug: string,
  extSlug: string
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  const registryPath = path.join(projectCwd(projectSlug), ".specify", "extensions", ".registry");
  let content: string;
  try {
    content = await fs.readFile(registryPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, changed: false };
    return { ok: false, reason: `registry read failed: ${(err as Error).message}` };
  }
  let parsed: { schema_version?: string; extensions?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { ok: false, reason: `registry JSON parse failed: ${(err as Error).message}` };
  }
  if (!parsed.extensions || typeof parsed.extensions !== "object") return { ok: true, changed: false };
  if (!(extSlug in parsed.extensions)) return { ok: true, changed: false };
  delete parsed.extensions[extSlug];
  await fs.writeFile(registryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { ok: true, changed: true };
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const extSlug = getRouterParam(event, "extSlug");
  if (!slug || !extSlug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/extSlug" });
  }

  const manifestPath = path.join(dataDir(), ".specops", slug, "extensions.json");
  let manifest: ExtensionsManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ExtensionsManifest;
  } catch {
    manifest = { slug, extensions: [], updatedAt: null };
  }

  // Removal pipeline: CLI first (deregisters hooks/commands), then physical cleanup of
  // anything the CLI left behind (orphan folder, registry entry), then UI manifest.
  // Each step is best-effort and reported back in the event log so partial failures are
  // visible instead of silent — this route previously dropped the UI entry even when the
  // folder stayed on disk, which leaked ghost workflows into the picker.
  const { runCommand } = await loadRunCommand();
  const cliResult = await runCommand("specify", ["extension", "remove", extSlug], {
    cwd: projectCwd(slug)
  });

  const extDir = path.join(projectCwd(slug), ".specify", "extensions", extSlug);
  let folderError: string | null = null;
  try {
    await fs.rm(extDir, { recursive: true, force: true });
  } catch (err) {
    folderError = (err as Error).message;
  }

  const registryResult = await removeFromRegistry(slug, extSlug);

  manifest.extensions = manifest.extensions.filter((e) => e.slug !== extSlug);
  manifest.updatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const cleanupNotes: string[] = [];
  if (cliResult.ok) {
    if (cliResult.stdout?.trim()) cleanupNotes.push(`CLI: ${cliResult.stdout.trim()}`);
  } else {
    cleanupNotes.push(
      `CLI fehlgeschlagen: ${(cliResult.stderr || cliResult.stdout || "unbekannter Fehler").trim()}`
    );
  }
  if (folderError) cleanupNotes.push(`Ordner-Cleanup fehlgeschlagen: ${folderError}`);
  if (!registryResult.ok) cleanupNotes.push(`Registry-Cleanup fehlgeschlagen: ${registryResult.reason}`);
  else if (registryResult.changed) cleanupNotes.push("Registry-Eintrag entfernt.");

  const fullyClean = cliResult.ok && !folderError && registryResult.ok;

  const events = await loadEventStore(slug);
  await events.append({
    type: "extension_uninstalled",
    level: fullyClean ? "info" : "warning",
    slug,
    createdAt: new Date().toISOString(),
    title: `Extension '${extSlug}' entfernt`,
    message: cleanupNotes.length > 0 ? cleanupNotes.join("\n") : undefined
  });

  return {
    slug,
    extSlug,
    cliOk: cliResult.ok,
    folderRemoved: folderError === null,
    registryCleaned: registryResult.ok,
    cliMessage: cliResult.ok ? cliResult.stdout : cliResult.stderr
  };
});
