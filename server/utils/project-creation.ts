import path from "node:path";
import { pathToFileURL } from "node:url";
import { installExtensionsInProject } from "./extension-install";

async function importModule<T = Record<string, unknown>>(relativePath: string): Promise<T> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), relativePath)).href;
  return import(moduleUrl) as Promise<T>;
}

export async function createProjectRecord(options: {
  title: string;
  description: string;
  extensions?: string[];
  workflow?: string;
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

  const cwd = process.cwd();
  const projectsRoot = path.join(cwd, "projects");
  const projectRoot = path.join(projectsRoot, slug);
  const store = new ArtifactStore(cwd);

  await ensureDir(projectsRoot);

  // `specify init` is interactive by default (arrow-key menu for AI selection, git-init prompt).
  // --ai claude and --no-git make it fully non-interactive so spawn() from Nuxt can succeed.
  // We run git init separately below so each project has its own repo boundary — this prevents
  // Claude Code from walking up to the haex-corp root and loading its CLAUDE.md context.
  const initArgs = ["init", slug, "--ai", "claude", "--no-git"];
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

  // Initialize a git repository in the project directory so Claude Code treats it as an
  // independent project root — preventing context bleed from the haex-corp parent CLAUDE.md.
  // (haex-corp/.gitignore already excludes projects/, so there's no nested-repo issue.)
  await runCommand("git", ["init", "-b", "main"], { cwd: projectRoot });
  await runCommand("git", ["config", "user.email", "agent@haex-corp.local"], { cwd: projectRoot });
  await runCommand("git", ["config", "user.name", "haex-corp"], { cwd: projectRoot });

  // Write a project-scoped CLAUDE.md that establishes company workflow context and prevents
  // Claude from pulling in haex-corp platform knowledge.
  const fs = await import("node:fs/promises");
  const claudeMd = [
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
  await fs.writeFile(path.join(projectRoot, "CLAUDE.md"), claudeMd).catch(() => {});

  // Write project-scoped Claude settings — only allow operations relevant to company workflow.
  await ensureDir(path.join(projectRoot, ".claude"));
  const claudeSettings = {
    permissions: {
      allow: [
        "Bash(node scripts/validate.mjs *)",
        "Bash(git status)",
        "Bash(git log *)",
        "Bash(git diff *)",
        "Bash(ls *)",
        "Bash(find . *)"
      ]
    }
  };
  await fs
    .writeFile(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify(claudeSettings, null, 2))
    .catch(() => {});

  // Exclude installed extensions from git — they have their own repos.
  await fs.writeFile(path.join(projectRoot, ".gitignore"), ".specify/extensions/\n").catch(() => {});

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
    const { manifest } = await installExtensionsInProject(slug, chosenExtensions, "auto");
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
