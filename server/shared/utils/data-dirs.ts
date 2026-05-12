import fs from "node:fs/promises";
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
 * Ephemeral HOME-Verzeichnis für einen Claude-OAuth-Flow.
 *
 * Die Claude-CLI schreibt `$HOME/.claude/.credentials.json` während des
 * `auth login` Subprozesses. Wir wollen die Tokens NICHT persistent auf
 * dem FS lagern (Volume-Mount-frei, kein Host-Bind), sondern direkt nach
 * dem Login auslesen, verschlüsselt in die DB schreiben und das Verzeichnis
 * wegräumen. Daher ein deterministischer Pfad unter os.tmpdir() pro
 * credential-id — deterministisch, damit der code.post.ts-Endpoint denselben
 * Pfad findet, ohne den Flow-Driver nach dem Pfad fragen zu müssen.
 *
 * UUID-Validation: das Resultat geht in einen spawn()-arg.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function oauthTempHome(credentialId: string): string {
  if (!UUID_REGEX.test(credentialId)) {
    throw new Error(`invalid credentialId (not a uuid): ${credentialId}`);
  }
  return path.join(os.tmpdir(), "specifyr-oauth", credentialId);
}

/**
 * Räumt das ephemerale OAuth-HOME nach erfolgreichem oder abgebrochenem
 * Flow auf. Idempotent — ENOENT wird verschluckt.
 */
export async function removeOauthTempHome(credentialId: string): Promise<void> {
  const dir = oauthTempHome(credentialId);
  await fs.rm(dir, { recursive: true, force: true });
}
