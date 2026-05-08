import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { projectCwd, loadEventStore } from "./specifyr-stores";
import { dataDir, extensionsDir } from "./data-dirs";
import { getAppConfigModule } from "./app-config";
import { getOrgExtensionBySlug } from "./org-extensions-store";

export interface ExtensionInstallRecord {
  slug: string;
  installedAt: string;
  source: "auto" | "manual";
  status: "installed" | "failed";
  message?: string;
}

export interface ExtensionsManifest {
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

function manifestPathFor(projectSlug: string): string {
  return path.join(dataDir(), ".specifyr", projectSlug, "extensions.json");
}

export async function readManifest(projectSlug: string): Promise<ExtensionsManifest> {
  const file = manifestPathFor(projectSlug);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as ExtensionsManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { slug: projectSlug, extensions: [], updatedAt: null };
    }
    throw err;
  }
}

async function writeManifest(projectSlug: string, manifest: ExtensionsManifest): Promise<void> {
  const file = manifestPathFor(projectSlug);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function installExtensionsInProject(
  projectSlug: string,
  extensionSlugs: string[],
  source: "auto" | "manual" = "manual",
  ownerOrgId: string | null = null
): Promise<{ manifest: ExtensionsManifest; installed: ExtensionInstallRecord[]; skipped: string[] }> {
  const manifest = await readManifest(projectSlug);
  const alreadyInstalled = new Set(
    manifest.extensions.filter((e) => e.status === "installed").map((e) => e.slug)
  );
  const toInstall = extensionSlugs
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !alreadyInstalled.has(s));
  const skipped = extensionSlugs.filter((s) => alreadyInstalled.has(s.trim()));

  if (toInstall.length === 0) {
    return { manifest, installed: [], skipped };
  }

  const { runCommand } = await loadRunCommand();
  const cwd = projectCwd(projectSlug);

  // Ensure the community catalog is registered as install-allowed. spec-kit's built-in community
  // catalog is discovery-only, so `extension add` would refuse otherwise. Idempotent best-effort:
  // if the catalog is already registered, the CLI fails gracefully and we move on.
  await runCommand(
    "specify",
    [
      "extension",
      "catalog",
      "add",
      "https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.community.json",
      "--name",
      "community-allowed",
      "--priority",
      "1",
      "--install-allowed"
    ],
    { cwd }
  );

  const installed: ExtensionInstallRecord[] = [];
  const { findLocalExtensionPath } = await getAppConfigModule();

  for (const slug of toInstall) {
    // Resolution order:
    //   1. org-scoped — DB row is the source of truth. If the row
    //      exists but the on-disk clone is missing, fail closed rather
    //      than letting the slug fall through to a deployment/community
    //      extension that happens to share the name.
    //   2. app-config localExtensions (deployment-global + bundled).
    //   3. global extensions dir.
    //   4. community catalog (no `--dev`, by slug).
    let localPath: string | null = null;
    let resolutionFailed = false;
    let resolutionFailureMessage = "";
    if (ownerOrgId) {
      const orgRow = await getOrgExtensionBySlug(ownerOrgId, slug);
      if (orgRow) {
        const onDisk = await fs.access(orgRow.path).then(() => true).catch(() => false);
        if (onDisk) {
          localPath = orgRow.path;
        } else {
          resolutionFailed = true;
          resolutionFailureMessage = `org extension '${slug}' is registered but the on-disk clone is missing — re-add the extension`;
        }
      }
    }
    if (!resolutionFailed && !localPath) {
      localPath = await findLocalExtensionPath(slug);
    }
    if (!resolutionFailed && !localPath) {
      const globalPath = path.join(extensionsDir(), slug);
      try {
        await fs.access(globalPath);
        localPath = globalPath;
      } catch { /* not in global dir */ }
    }
    let result: { ok: boolean; stdout?: string; stderr?: string };
    if (resolutionFailed) {
      result = { ok: false, stderr: resolutionFailureMessage };
    } else {
      const args = localPath
        ? ["extension", "add", "--dev", localPath]
        : ["extension", "add", slug];
      result = await runCommand("specify", args, { cwd });
    }
    const record: ExtensionInstallRecord = {
      slug,
      installedAt: new Date().toISOString(),
      source,
      status: result.ok ? "installed" : "failed",
      message: result.ok
        ? result.stdout?.trim() || undefined
        : (result.stderr || result.stdout || "specify extension add failed").trim()
    };
    installed.push(record);
    // Replace any prior record for the same slug (e.g., a previous failed attempt)
    manifest.extensions = manifest.extensions.filter((e) => e.slug !== slug);
    manifest.extensions.push(record);
  }

  manifest.updatedAt = new Date().toISOString();
  await writeManifest(projectSlug, manifest);

  const events = await loadEventStore(projectSlug);
  for (const record of installed) {
    await events.append({
      type: "extension_installed",
      level: record.status === "installed" ? "info" : "warning",
      slug: projectSlug,
      createdAt: record.installedAt,
      title: `Extension '${record.slug}' ${record.status === "installed" ? "installiert" : "fehlgeschlagen"}`,
      message: record.message
    });
  }

  return { manifest, installed, skipped };
}
