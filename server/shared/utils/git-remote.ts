/**
 * Git operations against a per-project remote (HTTPS + PAT).
 *
 * The PAT is injected per-invocation via `git -c http.extraHeader=...`
 * — it never lands in `.git/config`, never persists on disk, and any
 * accidental leak into stdout/stderr is scrubbed before we return.
 *
 * SSRF / private-IP validation reuses {@link assertRemoteSafe} from
 * git-clone.ts so we have one allowlist + one DNS check across the
 * codebase.
 */

import { spawn } from "node:child_process";
import { assertRemoteSafe } from "./git-clone";

export interface RunGitOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  /** Bearer/PAT — injected as Basic-auth http.extraHeader per call. */
  bearerToken?: string;
}

export interface RunGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function redact(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("***");
}

export async function runGitInProject(
  opts: RunGitOptions,
): Promise<RunGitResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const flagArgs: string[] = [];
  if (opts.bearerToken) {
    const b64 = Buffer.from(`x-access-token:${opts.bearerToken}`).toString(
      "base64",
    );
    flagArgs.push("-c", `http.extraHeader=Authorization: Basic ${b64}`);
  }
  const child = spawn("git", [...flagArgs, ...opts.args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/echo",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code: number | null = await new Promise((resolve) => {
    child.on("error", () => resolve(null));
    child.on("exit", resolve);
  });
  clearTimeout(timer);
  return {
    ok: code === 0,
    stdout: redact(stdout, opts.bearerToken),
    stderr: redact(stderr, opts.bearerToken),
  };
}

/**
 * Validate the URL shape (https, no inline credentials, no private
 * hosts) before we hand it to git. `file://` is accepted only when
 * SPECIFYR_ALLOW_FILE_REMOTES=1, which the test suite sets — never in
 * production.
 */
async function validateRemoteUrl(url: string): Promise<void> {
  if (url.startsWith("file://")) {
    if (process.env.SPECIFYR_ALLOW_FILE_REMOTES !== "1") {
      throw new Error("file:// remotes are not allowed");
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("only https:// remote URLs are supported");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("only https:// remote URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("remote URL must not contain inline credentials");
  }
  await assertRemoteSafe(parsed);
}

export interface CommitAndPushOptions {
  projectRoot: string;
  branch: string;
  message: string;
  bearerToken?: string;
}

export interface CommitAndPushResult {
  ok: boolean;
  pushed: boolean;
  stderr: string;
}

export async function commitAndPush(
  opts: CommitAndPushOptions,
): Promise<CommitAndPushResult> {
  const status = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["status", "--porcelain"],
  });
  if (!status.ok) return { ok: false, pushed: false, stderr: status.stderr };
  if (status.stdout.trim().length === 0) {
    return { ok: true, pushed: false, stderr: "" };
  }

  const add = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["add", "-A"],
  });
  if (!add.ok) return { ok: false, pushed: false, stderr: add.stderr };

  const commit = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["commit", "-m", opts.message],
  });
  if (!commit.ok) return { ok: false, pushed: false, stderr: commit.stderr };

  const push = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["push", "origin", `HEAD:${opts.branch}`],
    bearerToken: opts.bearerToken,
    timeoutMs: 120_000,
  });
  if (!push.ok) return { ok: false, pushed: false, stderr: push.stderr };
  return { ok: true, pushed: true, stderr: "" };
}

export interface PullFromRemoteOptions {
  projectRoot: string;
  branch: string;
  bearerToken?: string;
}

export interface PullFromRemoteResult {
  ok: boolean;
  updated: boolean;
  stderr: string;
}

export async function pullFromRemote(
  opts: PullFromRemoteOptions,
): Promise<PullFromRemoteResult> {
  const status = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["status", "--porcelain"],
  });
  if (!status.ok) return { ok: false, updated: false, stderr: status.stderr };
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      updated: false,
      stderr: "working tree has uncommitted changes",
    };
  }
  const before = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["rev-parse", "HEAD"],
  });
  const pull = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["pull", "--ff-only", "origin", opts.branch],
    bearerToken: opts.bearerToken,
    timeoutMs: 120_000,
  });
  if (!pull.ok) return { ok: false, updated: false, stderr: pull.stderr };
  const after = await runGitInProject({
    cwd: opts.projectRoot,
    args: ["rev-parse", "HEAD"],
  });
  return {
    ok: true,
    updated: before.stdout.trim() !== after.stdout.trim(),
    stderr: "",
  };
}

export async function configureRemote(
  repoPath: string,
  url: string,
): Promise<void> {
  await validateRemoteUrl(url);

  const existing = await runGitInProject({ cwd: repoPath, args: ["remote"] });
  if (!existing.ok) {
    throw new Error(existing.stderr || "failed to list remotes");
  }
  const remotes = existing.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (remotes.includes("origin")) {
    const upd = await runGitInProject({
      cwd: repoPath,
      args: ["remote", "set-url", "origin", url],
    });
    if (!upd.ok) throw new Error(upd.stderr || "failed to update remote");
  } else {
    const add = await runGitInProject({
      cwd: repoPath,
      args: ["remote", "add", "origin", url],
    });
    if (!add.ok) throw new Error(add.stderr || "failed to add remote");
  }
}
