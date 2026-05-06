import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/fs.js";
import { SPECIFYR_DIR } from "./constants.js";

const DEFAULT_APP_CONFIG = {
  standardExtensions: ["superpowers-bridge"],
  localExtensions: [],
  runner: {
    default: "hermes",
    fallbackChain: ["acp:gemini", "hermes", "superpowers", "claude"]
  },
  claude: {
    binary: "claude"
  },
  hermes: {
    binary: "hermes"
  },
  acp: {
    gemini: { binary: "gemini", args: ["--experimental-acp"] }
  }
};

function configPath(cwd) {
  return path.join(cwd, SPECIFYR_DIR, "config.json");
}

export async function loadAppConfig(cwd = process.cwd()) {
  const saved = await readJson(configPath(cwd), null);
  if (!saved) {
    return structuredClone(DEFAULT_APP_CONFIG);
  }
  // shallow-merge with defaults so new fields appear automatically
  return {
    ...structuredClone(DEFAULT_APP_CONFIG),
    ...saved,
    runner: { ...DEFAULT_APP_CONFIG.runner, ...(saved.runner ?? {}) },
    claude: { ...DEFAULT_APP_CONFIG.claude, ...(saved.claude ?? {}) },
    hermes: { ...DEFAULT_APP_CONFIG.hermes, ...(saved.hermes ?? {}) },
    acp: { ...DEFAULT_APP_CONFIG.acp, ...(saved.acp ?? {}) }
  };
}

export async function saveAppConfig(next, cwd = process.cwd()) {
  const filePath = configPath(cwd);
  await ensureDir(path.dirname(filePath));
  await writeJson(filePath, next);
  return next;
}

export async function setStandardExtensions(extensions, cwd = process.cwd()) {
  if (!Array.isArray(extensions)) {
    throw new Error("standardExtensions must be an array of strings");
  }
  const cleaned = Array.from(new Set(extensions.map((x) => String(x).trim()).filter(Boolean)));
  const current = await loadAppConfig(cwd);
  const next = { ...current, standardExtensions: cleaned };
  await saveAppConfig(next, cwd);
  return next.standardExtensions;
}

// Local extensions are filesystem-path registrations (e.g. /home/user/my-ext). They are
// referenced by slug everywhere else in the app; the registration maps slug -> path.
// A slug appearing here takes precedence over the community catalog during install
// (see server/utils/extension-install.ts).

function normalizeLocalEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("local extension entry must be an object");
  }
  const slug = String(entry.slug ?? "").trim();
  const pathValue = String(entry.path ?? "").trim();
  if (!slug) throw new Error("local extension entry requires a non-empty slug");
  if (!pathValue) throw new Error("local extension entry requires a non-empty path");
  return {
    slug,
    path: pathValue,
    registeredAt: entry.registeredAt || new Date().toISOString()
  };
}

export async function addLocalExtension(entry, cwd = process.cwd()) {
  const normalized = normalizeLocalEntry(entry);
  const current = await loadAppConfig(cwd);
  const existing = current.localExtensions ?? [];
  if (existing.some((e) => e.slug === normalized.slug)) {
    throw new Error(`local extension '${normalized.slug}' is already registered`);
  }
  const next = { ...current, localExtensions: [...existing, normalized] };
  await saveAppConfig(next, cwd);
  return normalized;
}

export async function removeLocalExtension(slug, cwd = process.cwd()) {
  const target = String(slug ?? "").trim();
  if (!target) throw new Error("slug is required");
  const current = await loadAppConfig(cwd);
  const existing = current.localExtensions ?? [];
  const kept = existing.filter((e) => e.slug !== target);
  if (kept.length === existing.length) {
    throw new Error(`local extension '${target}' is not registered`);
  }
  const next = { ...current, localExtensions: kept };
  // Also drop it from the standard-extensions list so the UI doesn't show a dangling slug.
  next.standardExtensions = (next.standardExtensions ?? []).filter((s) => s !== target);
  await saveAppConfig(next, cwd);
  return { slug: target };
}

export async function findLocalExtensionPath(slug, cwd = process.cwd()) {
  const target = String(slug ?? "").trim();
  if (!target) return null;
  const current = await loadAppConfig(cwd);
  const found = (current.localExtensions ?? []).find((e) => e.slug === target);
  return found ? found.path : null;
}
