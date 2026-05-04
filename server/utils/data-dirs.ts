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
