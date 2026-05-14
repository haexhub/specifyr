/**
 * Fire-and-forget auto-push trigger. Called by step-completion and
 * run-finalize hooks to flush workflow changes to the remote without
 * making the user wait for the push.
 *
 * Behavior:
 * - No-op when no repository is configured for the slug.
 * - Debounces rapid calls per slug (5s) — multiple step-saves within
 *   the window collapse to a single push, avoiding push-storms.
 * - Never throws: a push failure is logged but must not break the
 *   triggering request.
 */

import path from "node:path";
import { getProjectRepository } from "./project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "./secrets-store";
import { configureRemote, commitAndPush } from "./git-remote";
import { projectsDir } from "./data-dirs";

export interface AutoPushResult {
  skipped: boolean;
  ok: boolean;
  pushed: boolean;
  stderr: string;
}

/**
 * Caller-provided push hook used in tests so we don't need a real
 * upstream. Production callers omit it and the default
 * configureRemote + commitAndPush path runs.
 */
export interface AutoPushOptions {
  debounceMs?: number;
  push?: () => Promise<{ ok: boolean; pushed: boolean; stderr: string }>;
}

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_MESSAGE = "specifyr: workflow progress";

const pending = new Map<string, NodeJS.Timeout>();

async function defaultPush(
  slug: string,
): Promise<{ ok: boolean; pushed: boolean; stderr: string }> {
  const cfg = await getProjectRepository(slug);
  if (!cfg) return { ok: true, pushed: false, stderr: "" };
  const secrets = await getProjectSecrets(slug);
  const token = secrets[GIT_REMOTE_TOKEN_KEY];
  if (!token) return { ok: false, pushed: false, stderr: "token missing" };
  const projectRoot = path.join(projectsDir(), slug);
  await configureRemote(projectRoot, cfg.url);
  return commitAndPush({
    projectRoot,
    branch: cfg.branch,
    message: DEFAULT_MESSAGE,
    bearerToken: token,
  });
}

export async function triggerAutoPushImmediate(
  slug: string,
  opts: AutoPushOptions = {},
): Promise<AutoPushResult> {
  const cfg = await getProjectRepository(slug);
  if (!cfg) {
    return { skipped: true, ok: true, pushed: false, stderr: "" };
  }
  try {
    const push = opts.push ?? (() => defaultPush(slug));
    const result = await push();
    return { skipped: false, ...result };
  } catch (err) {
    const stderr = (err as Error).message;
    console.warn(`[repository-autosync] push failed for ${slug}: ${stderr}`);
    return { skipped: false, ok: false, pushed: false, stderr };
  }
}

/**
 * Schedule an auto-push. Multiple calls within debounceMs reset the
 * timer, so only the trailing-edge invocation actually runs.
 */
export function triggerAutoPush(
  slug: string,
  opts: AutoPushOptions = {},
): void {
  const existing = pending.get(slug);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(slug);
    void triggerAutoPushImmediate(slug, opts);
  }, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  // Avoid keeping the Node event loop alive on its own.
  timer.unref?.();
  pending.set(slug, timer);
}
