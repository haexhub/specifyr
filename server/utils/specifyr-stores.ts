import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir, projectsDir, hostProjectsDir } from "./data-dirs";

async function loadModule<T = Record<string, unknown>>(rel: string): Promise<T> {
  const url = pathToFileURL(path.join(process.cwd(), rel)).href;
  return import(url) as Promise<T>;
}

export async function loadSessionStore() {
  const mod = await loadModule<{ SessionStore: new (cwd?: string) => any }>("src/core/session-store.js");
  return new mod.SessionStore(dataDir());
}

export async function loadStepStateStore() {
  const mod = await loadModule<{ StepStateStore: new (cwd?: string) => any; STEP_ORDER: string[] }>(
    "src/core/step-state.js"
  );
  return {
    store: new mod.StepStateStore(dataDir()),
    STEP_ORDER: mod.STEP_ORDER
  };
}

export async function loadEventStore(slug: string) {
  const mod = await loadModule<{ EventStore: new (baseDir: string) => any }>("src/core/event-store.js");
  const baseDir = path.join(dataDir(), "events", slug);
  return new mod.EventStore(baseDir);
}

export async function loadClaudeCodeRunner() {
  const mod = await loadModule<{
    ClaudeCodeRunner: new (opts?: { binary?: string; cwd?: string; onEvent?: (e: unknown) => void }) => any;
    extractAssistantText: (event: unknown) => string;
  }>("src/runners/claude-code.js");
  return mod;
}

// Module-scoped singleton — one TurnBroker per Node process. In Nitro dev mode HMR may
// reset this on file changes (in-flight Claude subprocesses become orphaned but keep running).
// Acceptable for dev; in production the module loads once and lives for the process lifetime.
let _turnBroker: any = null;
export async function loadTurnBroker() {
  if (_turnBroker) return _turnBroker;
  const brokerMod = await loadModule<{
    TurnBroker: new (opts: { sessionStore: unknown; runnerFactory: (o: unknown) => unknown }) => any;
  }>("src/core/turn-broker.js");
  const sessionStore = await loadSessionStore();
  const { ClaudeCodeRunner } = await loadClaudeCodeRunner();
  _turnBroker = new brokerMod.TurnBroker({
    sessionStore,
    runnerFactory: (opts: any) => new ClaudeCodeRunner(opts)
  });
  return _turnBroker;
}

export function projectCwd(slug: string): string {
  return path.join(projectsDir(), slug);
}

/**
 * Host-side equivalent of `process.cwd()` for use in Docker bind-mount sources.
 *
 * When specifyr runs inside a container, `process.cwd()` is `/app` — a path
 * the Docker daemon cannot resolve when spawning sibling containers via
 * /var/run/docker.sock (the daemon resolves bind sources against the HOST
 * filesystem, not against specifyr' container fs). Operators should set
 * `SPECIFYR_HOST_PROJECT_ROOT` to the host path that maps to /app.
 *
 * When specifyr runs natively on the host, the env var is unset and this
 * falls back to `process.cwd()` — host and container paths coincide.
 */
export function hostProjectRoot(): string {
  return process.env.SPECIFYR_HOST_PROJECT_ROOT || process.cwd();
}

export function projectHostCwd(slug: string): string {
  return path.join(hostProjectsDir(), slug);
}

export async function assertProjectExists(slug: string) {
  const fs = await import("node:fs/promises");
  const cwd = projectCwd(slug);
  try {
    await fs.access(cwd);
  } catch {
    throw createError({ statusCode: 404, statusMessage: `Project directory not found: projects/${slug}/` });
  }
}
