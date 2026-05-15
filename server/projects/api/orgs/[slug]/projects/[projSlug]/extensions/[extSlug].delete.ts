import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { projectArtifactsDir } from "@su/data-dirs";
import { projectCwd, loadEventStore } from "@su/specifyr-stores";

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
  orgId: string,
  projectSlug: string,
  extSlug: string
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  const registryPath = path.join(projectCwd(orgId, projectSlug), ".specify", "extensions", ".registry");
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
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const rawExtSlug = getRouterParam(event, "extSlug");
  if (!rawExtSlug) {
    throw createError({ statusCode: 400, statusMessage: "Missing extSlug" });
  }

  // Look the slug up in the project's extension manifest before touching the
  // filesystem. The manifest is the authoritative list of "installed in this
  // project" — user authorisation for the project is already enforced by the
  // project-access middleware, so this lookup is purely the "does it exist?"
  // gate. The slug returned from the manifest entry is the value we use for
  // every downstream FS / CLI / registry op; the URL-supplied raw value
  // never reaches a path.join. That makes the path-traversal / NUL checks
  // below defence-in-depth, not the primary safeguard.
  const manifestPath = path.join(projectArtifactsDir(orgId, slug), "extensions.json");
  let manifest: ExtensionsManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ExtensionsManifest;
  } catch {
    manifest = { slug, extensions: [], updatedAt: null };
  }

  const entry = manifest.extensions.find((e) => e.slug === rawExtSlug);
  if (!entry) {
    throw createError({
      statusCode: 404,
      statusMessage: `Extension '${rawExtSlug}' is not installed in this project.`,
    });
  }

  const extSlug = entry.slug;
  // Defence-in-depth: even with manifest lookup, a manifest that was written
  // with a poisoned slug (older code, hand-edited file) must not be allowed
  // to escape `.specify/extensions/`.
  if (
    extSlug === "." ||
    extSlug === ".." ||
    extSlug.includes("/") ||
    extSlug.includes("\\") ||
    extSlug.includes("\0")
  ) {
    throw createError({ statusCode: 400, statusMessage: "Invalid extSlug" });
  }

  // Removal pipeline: CLI first (deregisters hooks/commands), then physical cleanup of
  // anything the CLI left behind (orphan folder, registry entry), then UI manifest.
  // Each step is best-effort and reported back in the event log so partial failures are
  // visible instead of silent — this route previously dropped the UI entry even when the
  // folder stayed on disk, which leaked ghost workflows into the picker.
  const { runCommand } = await loadRunCommand();
  const cliResult = await runCommand("specify", ["extension", "remove", extSlug], {
    cwd: projectCwd(orgId, slug)
  });

  const extDir = path.join(projectCwd(orgId, slug), ".specify", "extensions", extSlug);
  let folderError: string | null = null;
  try {
    await fs.rm(extDir, { recursive: true, force: true });
  } catch (err) {
    folderError = (err as Error).message;
  }

  const registryResult = await removeFromRegistry(orgId, slug, extSlug);

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

  const events = await loadEventStore(orgId, slug);
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
