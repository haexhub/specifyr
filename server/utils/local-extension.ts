import path from "node:path";
import fs from "node:fs/promises";
import YAML from "yaml";
import { getAppConfigModule, type LocalExtensionEntry } from "./app-config";

export interface LocalExtensionMetadata extends LocalExtensionEntry {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  tags?: string[];
  commandCount?: number;
  hookCount?: number;
  /** Set when the path is missing or the manifest is unreadable/invalid. */
  error?: string;
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export interface ExtensionCommandEntry {
  name: string;
  file?: string;
  description?: string;
  aliases?: string[];
}

export interface ExtensionHookEntry {
  /** Lifecycle event (e.g. "after_specify", "before_implement"). */
  event: string;
  /** The command to execute on the event. */
  command: string;
  description?: string;
  /** If true, the user is prompted before the hook runs. */
  optional?: boolean;
  /** Prompt shown when optional === true. */
  prompt?: string;
}

interface ParsedManifest {
  slug: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  tags?: string[];
  repository?: string;
  homepage?: string;
  documentation?: string;
  requires?: { speckit_version?: string };
  commandCount: number;
  hookCount: number;
  commands: ExtensionCommandEntry[];
  hooks: ExtensionHookEntry[];
}

/**
 * Read and validate `<extensionRoot>/extension.yml`. Throws on any schema problem so that
 * registration fails loudly; `enrichLocalExtension` swallows the error into `.error` for
 * display purposes only.
 */
export async function readLocalManifest(extensionRoot: string): Promise<ParsedManifest> {
  const resolved = path.resolve(extensionRoot);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`not a directory: ${resolved}`);
  }
  const manifestPath = path.join(resolved, "extension.yml");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`extension.yml not found at ${manifestPath}`);
  }
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new Error(`extension.yml is not valid YAML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object") {
    throw new Error("extension.yml must be a mapping");
  }
  const root = doc as Record<string, unknown>;
  const ext = (root.extension ?? {}) as Record<string, unknown>;
  const slug = typeof ext.id === "string" ? ext.id.trim() : "";
  if (!slug) throw new Error("extension.id missing in extension.yml");
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`extension.id '${slug}' must match ${SLUG_PATTERN}`);
  }

  const provides = (root.provides ?? {}) as Record<string, unknown>;
  const commandsRaw = Array.isArray(provides.commands) ? provides.commands : [];
  const commands: ExtensionCommandEntry[] = commandsRaw
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
    .map((c) => ({
      name: typeof c.name === "string" ? c.name : "",
      file: typeof c.file === "string" ? c.file : undefined,
      description: typeof c.description === "string" ? c.description : undefined,
      aliases: Array.isArray(c.aliases) ? (c.aliases as unknown[]).map(String) : undefined
    }))
    .filter((c) => c.name);

  const hooksRaw = (root.hooks ?? {}) as Record<string, unknown>;
  const hooks: ExtensionHookEntry[] = Object.entries(hooksRaw)
    .filter((entry): entry is [string, Record<string, unknown>] =>
      entry[1] !== null && typeof entry[1] === "object"
    )
    .map(([event, h]) => ({
      event,
      command: typeof h.command === "string" ? h.command : "",
      description: typeof h.description === "string" ? h.description : undefined,
      optional: typeof h.optional === "boolean" ? h.optional : undefined,
      prompt: typeof h.prompt === "string" ? h.prompt : undefined
    }))
    .filter((h) => h.command);

  const requires = root.requires as Record<string, unknown> | undefined;
  const speckitVersion =
    requires && typeof requires.speckit_version === "string" ? requires.speckit_version : undefined;

  return {
    slug,
    name: typeof ext.name === "string" ? ext.name : undefined,
    version: typeof ext.version === "string" ? ext.version : undefined,
    description: typeof ext.description === "string" ? ext.description : undefined,
    author: typeof ext.author === "string" ? ext.author : undefined,
    license: typeof ext.license === "string" ? ext.license : undefined,
    tags: Array.isArray(root.tags) ? (root.tags as unknown[]).map(String) : undefined,
    repository: typeof ext.repository === "string" ? ext.repository : undefined,
    homepage: typeof ext.homepage === "string" ? ext.homepage : undefined,
    documentation: typeof ext.documentation === "string" ? ext.documentation : undefined,
    requires: speckitVersion ? { speckit_version: speckitVersion } : undefined,
    commandCount: commands.length,
    hookCount: hooks.length,
    commands,
    hooks
  };
}

export interface LocalExtensionDetailPayload {
  extension: {
    id: string;
    name: string;
    version?: string;
    description?: string;
    author?: string;
    license?: string;
    tags?: string[];
    repository?: string;
    homepage?: string;
    documentation?: string;
    requires?: { speckit_version?: string };
    provides?: { commands?: number; hooks?: number };
  };
  dependents: never[];
  readmeContent: string;
  source: "local";
  localPath: string;
  commands: ExtensionCommandEntry[];
  hooks: ExtensionHookEntry[];
}

/**
 * Build a detail payload for a locally-registered extension. Returns null when the
 * slug is not in the local-extensions list, signalling the caller to fall back to
 * the community catalog. Throws when the registration exists but the on-disk
 * manifest is broken or has drifted away from the registered slug — both are
 * actionable errors the UI should surface.
 *
 * No caching: local files can change freely, so we always read fresh.
 */
export async function getLocalExtensionDetail(
  slug: string,
  cwd?: string
): Promise<LocalExtensionDetailPayload | null> {
  const { loadAppConfig } = await getAppConfigModule();
  const cfg = await loadAppConfig(cwd);
  const entry = (cfg.localExtensions ?? []).find((e) => e.slug === slug);
  if (!entry) return null;

  const parsed = await readLocalManifest(entry.path);
  if (parsed.slug !== slug) {
    throw new Error(
      `extension.id on disk is '${parsed.slug}', but registered as '${slug}' — please re-register`
    );
  }

  const readmeContent = await fs
    .readFile(path.join(entry.path, "README.md"), "utf8")
    .catch(() => "");

  return {
    extension: {
      id: parsed.slug,
      name: parsed.name ?? parsed.slug,
      version: parsed.version,
      description: parsed.description,
      author: parsed.author,
      license: parsed.license,
      tags: parsed.tags,
      repository: parsed.repository,
      homepage: parsed.homepage,
      documentation: parsed.documentation,
      requires: parsed.requires,
      provides: { commands: parsed.commandCount, hooks: parsed.hookCount }
    },
    dependents: [],
    readmeContent,
    source: "local",
    localPath: entry.path,
    commands: parsed.commands,
    hooks: parsed.hooks
  };
}

export async function enrichLocalExtension(
  entry: LocalExtensionEntry
): Promise<LocalExtensionMetadata> {
  try {
    const parsed = await readLocalManifest(entry.path);
    if (parsed.slug !== entry.slug) {
      // The on-disk slug diverged from what was registered (user edited extension.yml after
      // registration). Surface this rather than silently masking it.
      return {
        ...entry,
        error: `extension.id on disk is '${parsed.slug}', but registered as '${entry.slug}'`
      };
    }
    return { ...entry, ...parsed };
  } catch (err) {
    return { ...entry, error: (err as Error).message };
  }
}
