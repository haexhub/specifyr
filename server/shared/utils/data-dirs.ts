import os from "node:os";
import path from "node:path";

/**
 * Single source of truth for all runtime data directory paths.
 *
 * Default layout under ~/.specifyr/:
 *   projects/   — one subdirectory per project slug
 *   extensions/ — global extension source directories
 *   state/      — per-project app state
 *
 * Every path is overridable via environment variables, making the layout
 * fully configurable for Docker deployments or custom setups.
 */

export function dataDir(): string {
  return process.env.SPECIFYR_DATA_DIR ?? path.join(os.homedir(), ".specifyr");
}

export function projectsDir(): string {
  return process.env.SPECIFYR_PROJECTS_DIR ?? path.join(dataDir(), "projects");
}

// Global extensions directory — extension source repos live here and are
// referenced via `specify extension add --dev <path>` rather than copied per-project.
export function extensionsDir(): string {
  return process.env.SPECIFYR_EXTENSIONS_DIR ?? path.join(dataDir(), "extensions");
}

// Docker-aware host path for projects — needed when specifyr runs in a container
// and spawns sibling Hermes agent containers whose bind-mount sources must be
// resolved against the HOST filesystem, not the container FS.
export function hostProjectsDir(): string {
  if (process.env.SPECIFYR_HOST_PROJECTS_DIR) return process.env.SPECIFYR_HOST_PROJECTS_DIR;
  if (process.env.SPECIFYR_HOST_DATA_DIR) return path.join(process.env.SPECIFYR_HOST_DATA_DIR, "projects");
  return projectsDir();
}

/**
 * Per-owner credentials directory. Phase 8 writes
 * `<credentialsDir()>/<ownerKind>/<ownerId>/.claude/.credentials.json`
 * via the spawned `claude auth login` subprocess; haex-claude-proxy
 * mounts this same directory and sets HOME for the per-request
 * `claude` invocation.
 *
 * In production (ansible-deployed), specifyr's container has the host
 * dir bind-mounted at /credentials → set SPECIFYR_CREDENTIALS_DIR=
 * /credentials. In dev, it falls back to <dataDir>/credentials so a
 * developer can iterate without ansible.
 */
export function credentialsDir(): string {
  return process.env.SPECIFYR_CREDENTIALS_DIR ?? path.join(dataDir(), "credentials");
}

/**
 * Resolves the absolute directory we set as HOME for a spawned claude
 * subprocess. The CLI reads from `$HOME/.claude/.credentials.json`,
 * so this returns the parent of `.claude/` — the .claude/ subdir is
 * created by the CLI itself on first write.
 *
 * Validates the input shape because the result goes straight into a
 * spawn() arg (path-traversal guard mirrors the proxy-side
 * homeForOwner check).
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ownerCredentialsHome(
  ownerKind: "user" | "org",
  ownerId: string,
): string {
  if (ownerKind !== "user" && ownerKind !== "org") {
    throw new Error(`invalid ownerKind: ${ownerKind}`);
  }
  if (!UUID_REGEX.test(ownerId)) {
    throw new Error(`invalid ownerId (not a uuid): ${ownerId}`);
  }
  return path.join(credentialsDir(), ownerKind, ownerId);
}
