import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

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
 * Reject any string that has reserved-range bits set. Covers the IPv4
 * spaces ordinary developers know about (loopback, RFC1918, link-local,
 * shared-CGN, metadata) plus IPv6 loopback / link-local / ULA / IPv4-
 * mapped equivalents. Anything else (incl. real public addresses) is
 * accepted.
 */
function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map((s) => Number(s));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // CGN
    if (a === 0) return true;
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
    // Unique-Local Addresses fc00::/7 → leading nibble in {fc, fd}.
    if (/^fc[0-9a-f][0-9a-f]:/.test(lower) || /^fd[0-9a-f][0-9a-f]:/.test(lower)) return true;
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4 address.
    const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  return false;
}

/**
 * Validates URL shape. Returns the parsed URL on success, throws an
 * Error with a user-readable message otherwise. Does NOT do DNS — that
 * happens in {@link assertHostNotPrivate} after parsing succeeds.
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
  // Inline basic-auth in the URL is a footgun: it would bypass the
  // encrypted credentials path and end up in DB / logs. Refuse it
  // explicitly here and have the caller pass `credentials` instead.
  if (parsed.username || parsed.password) {
    throw new Error("URL must not contain inline credentials; use the credentials field");
  }
  // URL.hostname strips brackets for IPv6 in some Node versions but
  // keeps them in others — normalise by trimming.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("URL host is not allowed");
  }
  // Literal-IP fast path: don't bother resolving, just check directly.
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new Error("URL host is not allowed");
  }
  return parsed;
}

/**
 * Resolve `hostname` (A + AAAA) and reject every result that lives in
 * a reserved range. This closes the public-name-pointing-at-private-IP
 * SSRF hole that string checks alone leave open. There is still a TOCTOU
 * window between this resolution and git's own resolution at clone time
 * (DNS rebinding); fixing that requires git to bind a pre-resolved IP,
 * which we don't do here. The protocol allowlist + repo sandbox limits
 * the blast radius even if rebinding wins.
 */
async function assertHostNotPrivate(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("URL host is not allowed");
    }
    return;
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(hostname, { all: true });
  } catch {
    throw new Error("URL host is not resolvable");
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error("URL host is not allowed");
    }
  }
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
 * Replace any `username:password@host` userinfo prefix with `***:***@`
 * in the given text. Covers both the raw and percent-encoded forms we
 * produce in {@link buildCloneUrl}, plus a generic fallback for any
 * stray basic-auth-shaped substring git might log.
 */
function redactSecrets(
  text: string,
  credentials?: { username: string; token: string } | null,
): string {
  let out = text;
  if (credentials) {
    const raw = `${credentials.username}:${credentials.token}@`;
    const enc = `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.token)}@`;
    out = out.split(raw).join("***:***@").split(enc).join("***:***@");
  }
  // Fallback: scrub anything that looks like userinfo@host, in case git
  // echoed the URL after re-encoding or normalisation.
  return out.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/g, "$1***:***@");
}

/**
 * Public wrapper used by callers outside this file (e.g. git-remote.ts)
 * that need the same allowlist before issuing remote-touching git
 * operations. Caller passes an already-parsed URL so we don't repeat
 * `new URL()` validation.
 */
export async function assertRemoteSafe(parsed: URL): Promise<void> {
  if (parsed.protocol !== "https:") {
    throw new Error("only https:// URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL must not contain inline credentials; use the credentials field");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("URL host is not allowed");
  }
  await assertHostNotPrivate(host);
}

/**
 * Run `git clone --depth 1 [--branch <ref>] <url> <destination>` with the
 * given options. The `.git` directory is removed on success so the
 * resulting tree contains no embedded credentials in `.git/config`.
 *
 * Destination must be an absolute path that does not yet exist.
 * Cleanup on failure is the caller's responsibility (we don't rm-rf a
 * partial clone here because the caller owns the sandbox boundary).
 */
export async function gitClone(opts: GitCloneOptions): Promise<GitCloneResult> {
  if (!path.isAbsolute(opts.destination)) {
    return { ok: false, stderr: "destination must be an absolute path" };
  }
  if (await fs.stat(opts.destination).then(() => true).catch(() => false)) {
    return { ok: false, stderr: "destination already exists" };
  }

  let parsed: URL;
  try {
    parsed = assertSafeUrl(opts.url);
    await assertHostNotPrivate(parsed.hostname.replace(/^\[|\]$/g, ""));
  } catch (err) {
    return { ok: false, stderr: (err as Error).message };
  }
  const cloneUrl = buildCloneUrl(parsed, opts.credentials ?? null);

  const args = ["clone", "--depth", "1"];
  if (opts.ref) args.push("--branch", opts.ref);
  args.push(cloneUrl, opts.destination);

  const creds = opts.credentials ?? null;
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
  child.stderr?.on("data", (chunk) =>
    stderr.push(redactSecrets(chunk.toString(), creds)),
  );

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const result = await new Promise<GitCloneResult>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stderr: `clone timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: redactSecrets(String(err), creds) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr: redactSecrets(stderr.join(""), creds) });
    });
  });

  if (result.ok) {
    // Drop .git so credentials baked into the remote URL don't sit in
    // .git/config. Re-clone is the update mechanism, not git pull.
    await fs.rm(`${opts.destination}/.git`, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}
