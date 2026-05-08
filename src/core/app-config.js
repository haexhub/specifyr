import path from "node:path";
import { ensureDir, exists, readJson, writeJson } from "../utils/fs.js";
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

// Extensions that ship with specifyr itself (cloned in Dockerfile prod stage,
// or available locally during dev). Injected into the resolved localExtensions
// list at load time when the on-disk path exists and the slug isn't already
// registered. Not persisted — vanishing from disk silently removes the entry.
// Paths are resolved relative to `cwd` (= repo root in dev, /app in container).
const BUNDLED_LOCAL_EXTENSIONS = [
  { slug: "speckit-company", path: "extensions/speckit-company" }
];

function configPath(cwd) {
  return path.join(cwd, SPECIFYR_DIR, "config.json");
}

async function injectBundledLocalExtensions(merged, cwd) {
  const registered = new Set((merged.localExtensions ?? []).map((e) => e.slug));
  for (const bundled of BUNDLED_LOCAL_EXTENSIONS) {
    if (registered.has(bundled.slug)) continue;
    const absPath = path.resolve(cwd, bundled.path);
    if (!(await exists(absPath))) continue;
    merged.localExtensions = [
      ...(merged.localExtensions ?? []),
      { slug: bundled.slug, path: absPath, registeredAt: new Date(0).toISOString() }
    ];
  }
}

/**
 * Loads the deployment-global app config. By default the bundled
 * extensions list is injected on top of `localExtensions` so callers
 * (workflow picker, extension installer) see them out of the box. The
 * injection is in-memory only; passing `{ injectBundled: false }`
 * skips it so write paths that round-trip through `saveAppConfig`
 * never persist absolute bundled paths into `config.json`.
 */
export async function loadAppConfig(cwd = process.cwd(), { injectBundled = true } = {}) {
  const saved = await readJson(configPath(cwd), null);
  const merged = saved
    ? {
        ...structuredClone(DEFAULT_APP_CONFIG),
        ...saved,
        runner: { ...DEFAULT_APP_CONFIG.runner, ...(saved.runner ?? {}) },
        claude: { ...DEFAULT_APP_CONFIG.claude, ...(saved.claude ?? {}) },
        hermes: { ...DEFAULT_APP_CONFIG.hermes, ...(saved.hermes ?? {}) },
        acp: {
          ...DEFAULT_APP_CONFIG.acp,
          ...(saved.acp ?? {}),
          gemini: {
            ...DEFAULT_APP_CONFIG.acp.gemini,
            ...(saved.acp?.gemini ?? {})
          }
        }
      }
    : structuredClone(DEFAULT_APP_CONFIG);
  if (injectBundled) await injectBundledLocalExtensions(merged, cwd);
  return merged;
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
  const current = await loadAppConfig(cwd, { injectBundled: false });
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
  const current = await loadAppConfig(cwd, { injectBundled: false });
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
  const current = await loadAppConfig(cwd, { injectBundled: false });
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
  // Read-only lookup → keep bundled injection so callers can resolve
  // bundled-only slugs that have no saved entry.
  const current = await loadAppConfig(cwd);
  const found = (current.localExtensions ?? []).find((e) => e.slug === target);
  return found ? found.path : null;
}
