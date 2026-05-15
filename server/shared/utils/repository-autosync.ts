/**
 * Fire-and-forget auto-push trigger. Called by step-completion and
 * run-finalize hooks to flush workflow changes to the remote without
 * making the user wait for the push.
 *
 * Behavior:
 * - No-op when no repository is configured for the (orgId, slug).
 * - Debounces rapid calls per (orgId, slug) (5s) — multiple step-saves
 *   within the window collapse to a single push, avoiding push-storms.
 * - Never throws: a push failure is logged but must not break the
 *   triggering request.
 */

import { getProjectRepository, setLastPushedAt } from "./project-repository";
import { getProjectSecrets, GIT_REMOTE_TOKEN_KEY } from "./secrets-store";
import { configureRemote, commitAndPush } from "./git-remote";
import { projectDir } from "./data-dirs";

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

function pendingKey(orgId: string, slug: string): string {
  return `${orgId}/${slug}`;
}

const pending = new Map<string, NodeJS.Timeout>();

async function defaultPush(
  orgId: string,
  slug: string,
): Promise<{ ok: boolean; pushed: boolean; stderr: string }> {
  const cfg = await getProjectRepository(orgId, slug);
  if (!cfg) return { ok: true, pushed: false, stderr: "" };
  const secrets = await getProjectSecrets(orgId, slug);
  const token = secrets[GIT_REMOTE_TOKEN_KEY];
  if (!token) return { ok: false, pushed: false, stderr: "token missing" };
  const projectRoot = projectDir(orgId, slug);
  await configureRemote(projectRoot, cfg.url);
  return commitAndPush({
    projectRoot,
    branch: cfg.branch,
    message: DEFAULT_MESSAGE,
    bearerToken: token,
  });
}

export async function triggerAutoPushImmediate(
  orgId: string,
  slug: string,
  opts: AutoPushOptions = {},
): Promise<AutoPushResult> {
  const cfg = await getProjectRepository(orgId, slug);
  if (!cfg) {
    return { skipped: true, ok: true, pushed: false, stderr: "" };
  }
  try {
    const push = opts.push ?? (() => defaultPush(orgId, slug));
    const result = await push();
    if (result.ok && result.pushed) {
      await setLastPushedAt(orgId, slug, new Date().toISOString()).catch(() => {});
    }
    return { skipped: false, ...result };
  } catch (err) {
    const stderr = (err as Error).message;
    console.warn(`[repository-autosync] push failed for ${orgId}/${slug}: ${stderr}`);
    return { skipped: false, ok: false, pushed: false, stderr };
  }
}

/**
 * Schedule an auto-push. Multiple calls within debounceMs reset the
 * timer, so only the trailing-edge invocation actually runs.
 */
export function triggerAutoPush(
  orgId: string,
  slug: string,
  opts: AutoPushOptions = {},
): void {
  const key = pendingKey(orgId, slug);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(key);
    void triggerAutoPushImmediate(orgId, slug, opts);
  }, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  // Avoid keeping the Node event loop alive on its own.
  timer.unref?.();
  pending.set(key, timer);
}
