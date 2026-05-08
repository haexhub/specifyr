import { spawn } from "node:child_process";
import fs from "node:fs/promises";

export interface GitCloneOptions {
  url: string;
  ref?: string | null;
  /** Optional HTTPS basic-auth credentials. Both fields required when set. */
  credentials?: { username: string; token: string } | null;
  /** Absolute target directory; must not already exist. */
  destination: string;
  /** Hard timeout in ms. */
  timeoutMs?: number;
}

export interface GitCloneResult {
  ok: boolean;
  stderr: string;
}

/**
 * Validates that the URL is a plain `https://...` URL pointing at a
 * non-loopback host. Rejects file://, git://, ssh://, and bracket-form
 * IPv6 URLs that resolve to loopback. The host check defends against
 * SSRF-style abuse where a malicious org admin would otherwise be able
 * to register `http://169.254.169.254/...` (cloud metadata) as a Git
 * remote — git wouldn't actually clone non-https, but failing fast
 * here makes the constraint explicit.
 */
function assertSafeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("only https:// URLs are supported");
  }
  // URL.hostname strips brackets for IPv6 in some Node versions but
  // keeps them in others — accept both forms for the loopback check.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.startsWith("169.254.") ||
    host.endsWith(".localhost")
  ) {
    throw new Error("URL host is not allowed");
  }
  // git deals with whatever ref it's given; we don't try to validate it
  // because the legal grammar is broad and our timeout bounds the cost.
  return parsed;
}

function buildCloneUrl(parsed: URL, credentials?: { username: string; token: string } | null): string {
  if (!credentials) return parsed.toString();
  // URL-encode both halves so a token containing `:` or `@` doesn't
  // poison the parse on the other side.
  const userInfo = `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.token)}`;
  const cloneUrl = new URL(parsed.toString());
  cloneUrl.username = "";
  cloneUrl.password = "";
  // Reconstruct manually because URL.username + URL.password percent-decode on read.
  return cloneUrl.toString().replace(/^https:\/\//, `https://${userInfo}@`);
}

/**
 * Run `git clone --depth 1 [--branch <ref>] <url> <destination>` with the
 * given options. The `.git` directory is removed on success so the
 * resulting tree contains no embedded credentials in `.git/config`.
 *
 * The destination must not already exist. Cleanup on failure is the
 * caller's responsibility (we don't rm-rf a partial clone here because
 * the caller knows the safe sandbox boundary).
 */
export async function gitClone(opts: GitCloneOptions): Promise<GitCloneResult> {
  let parsed: URL;
  try {
    parsed = assertSafeUrl(opts.url);
  } catch (err) {
    return { ok: false, stderr: (err as Error).message };
  }
  const cloneUrl = buildCloneUrl(parsed, opts.credentials ?? null);

  const args = ["clone", "--depth", "1"];
  if (opts.ref) args.push("--branch", opts.ref);
  args.push(cloneUrl, opts.destination);

  const stderr: string[] = [];
  const child = spawn("git", args, {
    env: {
      ...process.env,
      // Suppress askpass / credential helpers — for private repos the
      // credentials are inlined in the URL, anything else means the
      // caller forgot to attach creds and we should fail fast rather
      // than hang on a TTY prompt.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/echo",
      // Avoid carrying any user-level git config (e.g. credential
      // helpers binding to the host's keychain).
      HOME: "/tmp",
      // Don't follow .gitconfig from the runtime dir either.
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const result = await new Promise<GitCloneResult>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stderr: `clone timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr: stderr.join("") });
    });
  });

  if (result.ok) {
    // Drop .git so credentials baked into the remote URL don't sit in
    // .git/config. Re-clone is the update mechanism, not git pull.
    await fs.rm(`${opts.destination}/.git`, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}
