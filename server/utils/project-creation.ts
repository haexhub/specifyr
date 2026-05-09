import path from "node:path";
import { pathToFileURL } from "node:url";
import { installExtensionsInProject } from "./extension-install";
import { dataDir, projectsDir } from "./data-dirs";

async function importModule<T = Record<string, unknown>>(relativePath: string): Promise<T> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), relativePath)).href;
  return import(moduleUrl) as Promise<T>;
}

export async function createProjectRecord(options: {
  title: string;
  description: string;
  extensions?: string[];
  workflow?: string;
  ownerOrgId?: string | null;
}) {
  const [{ ArtifactStore }, { runCommand }, { ensureDir, slugify }] = await Promise.all([
    importModule<{ ArtifactStore: new (cwd?: string) => any }>("src/core/artifact-store.js"),
    importModule<{ runCommand: typeof import("../../src/utils/process.js").runCommand }>("src/utils/process.js"),
    importModule<{
      ensureDir: typeof import("../../src/utils/fs.js").ensureDir;
      slugify: typeof import("../../src/utils/fs.js").slugify;
    }>("src/utils/fs.js")
  ]);

  const title = options.title.trim();
  const description = options.description.trim();
  const slug = slugify(title);

  if (!slug) {
    throw new Error("Could not derive a valid project slug.");
  }

  const projectsRoot = projectsDir();
  const projectRoot = path.join(projectsRoot, slug);
  const store = new ArtifactStore(dataDir());

  await ensureDir(projectsRoot);

  // `specify init` is interactive by default (arrow-key menu for AI selection, git-init prompt).
  // --ai generic and --no-git make it fully non-interactive so spawn() from Nuxt can succeed.
  // We run git init separately below so each project has its own repo boundary — this prevents
  // coding agents from walking up to the specifyr root and loading platform context.
  const initArgs = ["init", slug, "--ai", "generic", "--no-git"];
  const initResult = await runCommand("specify", initArgs, { cwd: projectsRoot });
  const workflow = options.workflow ?? "spec-kit";
  const meta = {
    description,
    projectRoot,
    workflow,
    specifyInit: {
      attemptedAt: new Date().toISOString(),
      status: initResult.ok ? "completed" : "pending_manual_setup",
      command: `specify ${initArgs.join(" ")}`,
      message: initResult.ok
        ? initResult.stdout || "Spec Kit initialized successfully."
        : initResult.stderr || "Could not run `specify init` automatically."
    }
  };

  if (!initResult.ok) {
    await ensureDir(projectRoot);
  }

  // Initialize a git repository in the project directory so coding agents treat it as an
  // independent project root, preventing context bleed from the specifyr platform repo.
  // (specifyr/.gitignore already excludes projects/, so there's no nested-repo issue.)
  // Failures used to be silently ignored, which left projects without a repo
  // boundary while the comment claimed it was required — surface them now.
  const gitInit = await runCommand("git", ["init", "-b", "main"], { cwd: projectRoot });
  if (!gitInit.ok) {
    throw new Error(gitInit.stderr || "Failed to initialize git repository.");
  }
  const gitConfigEmail = await runCommand(
    "git",
    ["config", "user.email", "agent@specifyr.local"],
    { cwd: projectRoot }
  );
  if (!gitConfigEmail.ok) {
    throw new Error(gitConfigEmail.stderr || "Failed to set git user.email.");
  }
  const gitConfigName = await runCommand("git", ["config", "user.name", "specifyr"], {
    cwd: projectRoot,
  });
  if (!gitConfigName.ok) {
    throw new Error(gitConfigName.stderr || "Failed to set git user.name.");
  }

  // Write provider-neutral project guidance for ACP-backed coding agents.
  const fs = await import("node:fs/promises");
  const agentsMd = [
    `# ${title} — Company Workspace`,
    ``,
    `Dieses Projekt ist ein spec-gesteuertes Multi-Agenten-Unternehmen, aufgebaut mit dem speckit-company Framework.`,
    ``,
    `## Operationen hier`,
    `- Agent-Spezifikation und -Konfiguration (\`.specify/org/\`)`,
    `- Company-Workflow-Schritte (init, charter, hire, validate, start)`,
    `- Strategie-Arbeit wenn Agenten aktiv sind`,
    ``,
    `## Nicht hier`,
    `Dies ist **kein Softwareentwicklungs-Projekt**. Kein Vue/TypeScript/Nuxt-Code.`,
    `Beschränke dich auf Dateien in diesem Verzeichnis.`
  ].join("\n");
  await fs.writeFile(path.join(projectRoot, "AGENTS.md"), agentsMd);

  // Exclude installed extensions from git — they have their own repos.
  // `specify init` may have already written a .gitignore (template defaults,
  // OS junk patterns); merge the rule in instead of overwriting their content.
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const existingGitignore = await fs
    .readFile(gitignorePath, "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  const extensionIgnoreRule = ".specify/extensions/";
  if (!existingGitignore.split(/\r?\n/).includes(extensionIgnoreRule)) {
    const needsNewline = existingGitignore.length > 0 && !existingGitignore.endsWith("\n");
    await fs.writeFile(
      gitignorePath,
      `${existingGitignore}${needsNewline ? "\n" : ""}${extensionIgnoreRule}\n`
    );
  }

  // The community catalog is discovery-only by default in spec-kit. Our UI browses extensions
  // from there, so we need to opt-in to installation. Registered with priority 1 to take
  // precedence over the built-in community catalog (priority 2, discovery-only).
  if (initResult.ok) {
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
      { cwd: projectRoot }
    );
  }

  await store.createProject(slug, title, "", meta);
  await store.saveArtifact(slug, "run", {
    slug,
    currentStage: "draft",
    status: "draft",
    approvals: [],
    completedTaskIds: [],
    failedTaskIds: [],
    taskResults: {},
    updatedAt: new Date().toISOString()
  });

  // Install chosen extensions (best-effort; failures are recorded but don't abort creation).
  // installExtensionsInProject handles local extensions via --dev and writes the manifest.
  const chosenExtensions = Array.from(
    new Set((options.extensions ?? []).map((x) => String(x).trim()).filter(Boolean))
  );
  let extensionRecords: import("./extension-install").ExtensionInstallRecord[] = [];
  if (initResult.ok && chosenExtensions.length > 0) {
    const { manifest } = await installExtensionsInProject(
      slug,
      chosenExtensions,
      "auto",
      options.ownerOrgId ?? null
    );
    extensionRecords = manifest.extensions;
  }

  return {
    slug,
    title,
    description,
    projectRoot,
    specifyInit: meta.specifyInit,
    extensions: extensionRecords
  };
}
