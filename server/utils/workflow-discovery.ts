import path from "node:path";
import fs from "node:fs/promises";
import YAML from "yaml";
import { projectCwd } from "./specops-stores";

// Shape of .specify/extensions/.registry (spec-kit CLI's install-state file).
interface ExtensionRegistryEntry {
  enabled?: boolean;
}
interface ExtensionRegistry {
  extensions?: Record<string, ExtensionRegistryEntry>;
}

// Returns the set of slugs the spec-kit CLI considers enabled for this project,
// or `null` if the registry is absent/unreadable. `null` means "don't filter" — callers
// should treat every on-disk extension as installed, preserving behavior for projects
// that predate the registry or manage extensions outside the CLI. A readable-but-broken
// registry still returns `null` (we can't trust it, so we don't act on it).
async function readEnabledExtensionSlugs(projectSlug: string): Promise<Set<string> | null> {
  const registryPath = path.join(projectCwd(projectSlug), ".specify", "extensions", ".registry");
  let content: string;
  try {
    content = await fs.readFile(registryPath, "utf8");
  } catch {
    return null;
  }
  let parsed: ExtensionRegistry;
  try {
    parsed = JSON.parse(content) as ExtensionRegistry;
  } catch {
    return null;
  }
  const entries = parsed.extensions;
  if (!entries || typeof entries !== "object") return null;
  const enabled = new Set<string>();
  for (const [slug, entry] of Object.entries(entries)) {
    if (entry?.enabled === true) enabled.add(slug);
  }
  return enabled;
}

// A Workflow description as the client consumes it.
export interface WorkflowStep {
  id: string;
  label: string;
  command: string;
  summary: string;
  description: string;
  tips: string[];
  artifacts: string[];
  isRun?: boolean;
}

export interface WorkflowDefinition {
  id: string;
  label: string;
  description: string;
  source: "built-in" | "extension";
  extensionSlug?: string;
  steps: WorkflowStep[];
}

interface ExtensionCommandYaml {
  name: string;
  file?: string;
  description?: string;
  artifacts?: string[];
}

// Strip a leading YAML frontmatter block (`---\n...---\n`) if present.
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  const rest = md.slice(end + 4);
  return rest.startsWith("\n") ? rest.slice(1) : rest;
}

// AIDE-style extensions don't declare artifacts structurally — they mention them in prose as
// backtick-quoted relative paths (e.g. "store it in `docs/aide/vision.md`"). This extracts
// those mentions and ranks them so the step's OUTPUT comes first.
//
// A command body typically mentions both prerequisites (inputs from earlier steps) and the
// new artifact this step produces. Example: create-roadmap mentions vision.md AND roadmap.md.
// Without ranking, the ArtifactViewer would show the first-resolvable candidate, which is
// usually the prereq (it already exists) — the user would see the wrong file.
//
// Heuristic: a step's own output usually shares a token with the step id.
// create-vision → vision.md, create-roadmap → roadmap.md, create-progress → progress.md.
// We derive tokens from the step id (strip action verbs like "create"/"execute"), then score
// each candidate by whether its filename stem matches any token. Ties fall back to appearance
// order in the body. Paths with uppercase placeholders (NNN, XXX) are dropped — they're
// templates, not real paths.
const ARTIFACT_PATH_RE = /`([a-zA-Z0-9_./\-<>]+\.(?:md|json|ya?ml|txt))`/g;
const ACTION_VERBS = new Set(["create", "execute", "update", "generate", "write", "make"]);

function stepTokens(stepId: string): string[] {
  return stepId
    .split(/[-_]/)
    .filter((t) => t.length > 0 && !ACTION_VERBS.has(t.toLowerCase()));
}

// Detects template segments like "NNN-descriptive-name" or "queue-NNN" — two-plus consecutive
// uppercase letters in a path segment means "fill in the blank", not a real filename.
const TEMPLATE_SEGMENT_RE = /(?:^|-|_|\.)[A-Z]{2,}(?:-|_|\.|$)/;

function isTemplatePath(p: string): boolean {
  return p.split("/").some((seg) => TEMPLATE_SEGMENT_RE.test(seg));
}

// For paths like "docs/aide/items/NNN-descriptive-name.md", return the parent dir
// ("docs/aide/items") — the ArtifactViewer renders dir listings when it can't find a concrete
// file, which is the right fallback for steps that create one-file-per-invocation.
function templateToParentDir(p: string): string {
  const parts = p.split("/");
  // Drop trailing segments until we hit one without a template.
  while (parts.length > 0 && TEMPLATE_SEGMENT_RE.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
  return parts.join("/");
}

function extractArtifactPaths(body: string, stepId: string): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    ordered.push(p);
  };
  for (const m of body.matchAll(ARTIFACT_PATH_RE)) {
    const raw = m[1];
    if (!raw) continue;
    if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) continue;
    // Template paths collapse to the parent dir so the viewer can show a listing.
    // Real paths go through unchanged. `<feature>`-style placeholders stay — the viewer
    // already handles them with a special branch.
    push(isTemplatePath(raw) ? templateToParentDir(raw) : raw);
  }
  const tokens = stepTokens(stepId).map((t) => t.toLowerCase());
  if (tokens.length === 0) return ordered;
  // Keep only candidates whose last path segment contains a step token. For files this
  // matches on the filename stem (vision → vision.md); for dirs it matches on the dir
  // name (item → items/).
  //
  // Non-matching paths would be prerequisites (inputs from upstream steps) that the
  // command mentions in prose like "read `docs/aide/vision.md` first". If we kept them
  // as fallbacks, the ArtifactViewer would happily display an upstream file whenever
  // the current step's output doesn't exist yet — silently showing the wrong artifact.
  // Empty result is better than misleading result; the viewer falls back to the "not
  // yet created" empty state which honestly reflects the step's pre-run condition.
  const matches = ordered.filter((p) => {
    const last = p.split("/").filter(Boolean).pop() ?? "";
    const stem = last.replace(/\.[^.]+$/, "").toLowerCase();
    return tokens.some((t) => stem.includes(t));
  });
  return matches;
}

interface ExtensionYaml {
  schema_version?: string;
  extension?: {
    id?: string;
    name?: string;
    description?: string;
    version?: string;
  };
  provides?: {
    commands?: ExtensionCommandYaml[];
  };
  hooks?: unknown;
  tags?: string[];
}

// An extension is treated as a full-project workflow (vs. a utility that augments spec-kit) when
// ALL of the following hold:
//   (a) it declares the `workflow` tag in its extension.yml,
//   (b) it ships no hooks (hook-providing extensions inject into an existing flow — they are
//       utilities, not replacement flows),
//   (c) it ships at least 3 commands (1–2 commands is a single utility, not a workflow).
// The tag alone is too loose — community authors use it as a category label.
const WORKFLOW_MIN_COMMANDS = 3;

function isWorkflowShape(parsed: ExtensionYaml): boolean {
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).toLowerCase()) : [];
  if (!tags.includes("workflow")) return false;
  const hooks = parsed.hooks;
  const hasHooks = Array.isArray(hooks) ? hooks.length > 0 : !!hooks;
  if (hasHooks) return false;
  const commands = Array.isArray(parsed.provides?.commands) ? parsed.provides!.commands : [];
  if (commands.length < WORKFLOW_MIN_COMMANDS) return false;
  return true;
}

// Built-in spec-kit workflow — always available, no extension needed.
export const SPEC_KIT_WORKFLOW: WorkflowDefinition = {
  id: "spec-kit",
  label: "Spec Kit (Standard)",
  description:
    "Der klassische 5-Step-Flow: Constitution → Specify → Plan → Tasks → Implement. Feature-basierte Entwicklung.",
  source: "built-in",
  steps: [
    {
      id: "constitution",
      label: "Constitution",
      command: "/speckit.constitution",
      summary: "Prinzipien und Leitplanken des Projekts festlegen.",
      description:
        "Definiere die Grundsätze, an denen sich das Projekt durchgängig orientiert — Code-Qualität, Test-Standards, UX-Konsistenz, Performance. Das Ergebnis lebt in .specify/memory/constitution.md und dient Claude als Bezugsrahmen für alle späteren Schritte.",
      tips: [
        "Konkrete Regeln schlagen abstrakte Prinzipien: „Jede öffentliche API braucht OpenAPI-Spec\" statt „sauberer Code\".",
        "Widersprüchliche Prinzipien sorgen später für halb-umgesetzte Specs — lieber weniger, dafür eindeutig.",
        "Die Constitution legst du normalerweise einmal fest und änderst sie selten."
      ],
      artifacts: [".specify/memory/constitution.md"]
    },
    {
      id: "specify",
      label: "Specify",
      command: "/speckit.specify",
      summary: "Was und warum — Feature-Spec erarbeiten.",
      description:
        "Beschreibe WAS gebaut werden soll und WARUM. User-Stories, Feature-Verhalten, konkrete Szenarien, Akzeptanzkriterien.",
      tips: [
        "Spec-kit legt pro Feature einen nummerierten Ordner unter .specify/specs/ an.",
        "Benutze „Als erledigt markieren\", wenn die Spec wirklich steht.",
        "Nachträgliche Änderungen markieren Plan und Tasks automatisch als „veraltet\"."
      ],
      artifacts: [".specify/specs/<feature>/spec.md"]
    },
    {
      id: "plan",
      label: "Plan",
      command: "/speckit.plan",
      summary: "Wie — Technischen Plan ableiten.",
      description:
        "Übersetze die Spec in das WIE: Technologie-Stack, Architektur, Datenmodell, Integrations-Punkte, wichtige Bibliotheken.",
      tips: [
        "Konkrete Versionen und Libraries schreiben ist ok — spätestens Tasks brauchen das.",
        "Alternative Ansätze gegenüberstellen hilft, offene Fragen zu finden.",
        "Der Plan kann iterativ verfeinert werden — neue Session starten statt alten zu überschreiben."
      ],
      artifacts: [".specify/specs/<feature>/plan.md"]
    },
    {
      id: "tasks",
      label: "Tasks",
      command: "/speckit.tasks",
      summary: "Ausführbare Aufgaben mit Abhängigkeiten.",
      description:
        "Zerlege den Plan in konkrete, eigenständig ausführbare Aufgaben. Jede Task trägt ID, Abhängigkeiten und Erfolgskriterien.",
      tips: [
        "Tasks sollen so klein sein, dass ein Agent sie in einer Session erledigen kann.",
        "Wenn Abhängigkeiten fehlen, fährt der Scheduler später sequenziell."
      ],
      artifacts: [".specify/specs/<feature>/tasks.md", ".specops/<slug>/tasks.graph.json"]
    },
    {
      id: "implement",
      label: "Implement",
      command: "/speckit.implement",
      summary: "Tasks via Hermes ausführen.",
      description:
        "Hermes führt die Tasks aus — unabhängige parallel, abhängige sequenziell.",
      tips: [
        "Hermes lernt pro Projekt isoliert (.hermes/memory/).",
        "Bei fehlender Hermes-Binary wird auf Claude Code fallback umgeschaltet."
      ],
      artifacts: [],
      isRun: true
    }
  ]
};

// Humanize a command-suffix slug: "create-vision" → "Create Vision"
function humanizeStepId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Parse an extension.yml buffer into a WorkflowDefinition, if the extension declares
// itself as a workflow (tags include "workflow"). Returns null otherwise.
export function parseExtensionWorkflow(yamlContent: string): WorkflowDefinition | null {
  let parsed: ExtensionYaml;
  try {
    parsed = YAML.parse(yamlContent) as ExtensionYaml;
  } catch {
    return null;
  }

  if (!isWorkflowShape(parsed)) return null;

  const id = parsed.extension?.id?.trim();
  if (!id) return null;

  const commands = parsed.provides!.commands!;

  const steps: WorkflowStep[] = commands
    .map((cmd) => {
      const fullCommand = cmd.name?.trim();
      if (!fullCommand) return null;
      // Derive a short step id from the last dot-segment of the command name:
      // "speckit.aide.create-vision" → "create-vision"
      const shortId = fullCommand.split(".").pop() ?? fullCommand;
      const description = cmd.description?.trim() ?? "";
      const step: WorkflowStep = {
        id: shortId,
        label: humanizeStepId(shortId),
        command: `/${fullCommand}`,
        summary: description.split(/\. /)[0] || description,
        description,
        tips: [],
        artifacts: []
      };
      return step;
    })
    .filter((s): s is WorkflowStep => s !== null);

  if (steps.length === 0) return null;

  return {
    id,
    label: parsed.extension?.name?.trim() ?? id,
    description: parsed.extension?.description?.trim() ?? "",
    source: "extension",
    extensionSlug: id,
    steps
  };
}

// Read an installed extension's YAML from disk and return its workflow if applicable.
// Also loads each step's command-markdown file to populate `body` and extract `artifacts`.
export async function loadInstalledExtensionWorkflow(
  projectSlug: string,
  extensionSlug: string
): Promise<WorkflowDefinition | null> {
  const extDir = path.join(projectCwd(projectSlug), ".specify", "extensions", extensionSlug);
  const ymlPath = path.join(extDir, "extension.yml");

  let ymlContent: string;
  try {
    ymlContent = await fs.readFile(ymlPath, "utf8");
  } catch {
    return null;
  }
  const wf = parseExtensionWorkflow(ymlContent);
  if (!wf) return null;

  let parsedYaml: ExtensionYaml;
  try {
    parsedYaml = YAML.parse(ymlContent) as ExtensionYaml;
  } catch {
    return wf;
  }
  const commands = parsedYaml.provides?.commands ?? [];
  const cmdByName = new Map<string, ExtensionCommandYaml>();
  for (const cmd of commands) {
    if (cmd.name) cmdByName.set(cmd.name, cmd);
  }

  for (const step of wf.steps) {
    // Command looks like `/speckit.aide.create-vision` — drop the leading slash to match yml.
    const cmdName = step.command.replace(/^\//, "");
    const cmdDef = cmdByName.get(cmdName);
    if (!cmdDef) continue;

    // Prefer explicit artifact declarations in extension.yml over body heuristics.
    if (Array.isArray(cmdDef.artifacts) && cmdDef.artifacts.length > 0) {
      step.artifacts = cmdDef.artifacts;
      continue;
    }

    if (!cmdDef.file) continue;
    try {
      const raw = await fs.readFile(path.join(extDir, cmdDef.file), "utf8");
      step.artifacts = extractArtifactPaths(stripFrontmatter(raw), step.id);
    } catch {
      // Missing command file — step stays without artifacts; the UI degrades gracefully.
    }
  }

  return wf;
}

// Enumerate all installed extensions under the project and return those that declare a workflow.
// Cross-checks against .specify/extensions/.registry: if present, only slugs marked `enabled: true`
// are considered installed, so orphaned extension folders (e.g. a failed `extension remove`) stop
// leaking into the picker. If the registry is missing, all on-disk folders are scanned as before.
export async function listProjectWorkflowExtensions(projectSlug: string): Promise<WorkflowDefinition[]> {
  const extRoot = path.join(projectCwd(projectSlug), ".specify", "extensions");
  let entries: string[];
  try {
    entries = await fs.readdir(extRoot);
  } catch {
    return [];
  }
  const enabledSlugs = await readEnabledExtensionSlugs(projectSlug);
  const workflows: WorkflowDefinition[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (enabledSlugs && !enabledSlugs.has(name)) continue;
    const wf = await loadInstalledExtensionWorkflow(projectSlug, name);
    if (wf) workflows.push(wf);
  }
  return workflows;
}

// Return the full set of workflows available for a given project:
// always spec-kit, plus any installed workflow-extension.
export async function listProjectWorkflows(projectSlug: string): Promise<WorkflowDefinition[]> {
  const extensionWorkflows = await listProjectWorkflowExtensions(projectSlug);
  return [SPEC_KIT_WORKFLOW, ...extensionWorkflows];
}

// Resolve a workflow id to its definition for the project. Falls back to spec-kit.
export async function getProjectWorkflow(
  projectSlug: string,
  workflowId: string | null | undefined
): Promise<WorkflowDefinition> {
  if (!workflowId || workflowId === "spec-kit") return SPEC_KIT_WORKFLOW;
  const wf = await loadInstalledExtensionWorkflow(projectSlug, workflowId);
  return wf ?? SPEC_KIT_WORKFLOW;
}
