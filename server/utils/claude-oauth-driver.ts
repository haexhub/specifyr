/**
 * Drives the `claude auth login` subprocess for a single OAuth flow.
 *
 * Real flow (claude-code 2.1.x):
 *   1. spawn("claude", ["auth", "login", "--claudeai"], { env: { HOME } })
 *   2. CLI prints:
 *        Opening browser to sign in…
 *        If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
 *        Paste code here if prompted >  ← reads from stdin
 *   3. user opens URL in browser, authorizes; claude.com shows a code
 *   4. user pastes code into our UI; we forward it as `<code>\n` to the
 *      held-open subprocess's stdin
 *   5. CLI verifies via PKCE, writes $HOME/.claude/.credentials.json,
 *      and exits 0 — at which point the file watcher / status poll
 *      sees the file and we mark the credential authorized.
 *
 * Each driver instance is keyed on the credential row's id so the
 * frontend can poll status / submit a code without leaking process
 * handles. Callers MUST call cancel() on abandoned flows so stale
 * spawned processes don't stick around — there's a hard 15-min
 * timeout in this module as a backstop.
 *
 * The spawn function is injectable for tests.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface ClaudeOAuthDriverOptions {
  /**
   * Override the CLI binary. Defaults to `claude` on PATH; tests use
   * a fake spawn function entirely (see `spawnFn` below) and don't
   * need this.
   */
  claudeBin?: string;
  /**
   * Subprocess factory. Defaults to node:child_process.spawn. Tests
   * inject a fake that emits canned stdout / observes stdin writes.
   */
  spawnFn?: typeof nodeSpawn;
  /**
   * Hard ceiling on how long an OAuth flow may stay open before we
   * kill the subprocess and reject the pending row. 15 minutes is
   * comfortable for the human-in-the-loop step (open URL, log in,
   * authorize, paste back).
   */
  flowTimeoutMs?: number;
  /**
   * Override the URL-extraction regex. The default matches the
   * format claude-code 2.1.x prints:
   *   "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…"
   */
  urlRegex?: RegExp;
}

interface PendingFlow {
  id: string;
  proc: ChildProcess;
  url: string;
  home: string;
  startedAt: Date;
  stdoutBuf: string;
  stderrBuf: string;
  /** Resolved when the CLI exits successfully (credentials.json written). */
  donePromise: Promise<void>;
  resolveDone: () => void;
  rejectDone: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
  /** Set once submitCode has been called so we don't double-pipe. */
  codeSubmitted: boolean;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_URL_REGEX =
  /https:\/\/claude\.[a-z]+\/cai\/oauth\/authorize\?\S+/i;

export class ClaudeOAuthDriver {
  private readonly claudeBin: string;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly flowTimeoutMs: number;
  private readonly urlRegex: RegExp;
  private readonly flows = new Map<string, PendingFlow>();

  constructor(opts: ClaudeOAuthDriverOptions = {}) {
    this.claudeBin =
      opts.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
    this.spawnFn = opts.spawnFn ?? nodeSpawn;
    this.flowTimeoutMs = opts.flowTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.urlRegex = opts.urlRegex ?? DEFAULT_URL_REGEX;
  }

  /**
   * Begins an OAuth flow. Creates `<home>/.claude/` so the CLI has a
   * place to write `.credentials.json` later, spawns the CLI, waits
   * for the URL to appear in stdout, and returns it. The caller is
   * expected to persist the flow id (returned) — it's the handle for
   * later `submitCode` / `cancel` / `awaitCompletion`.
   */
  async startLogin(input: { id: string; home: string }): Promise<{ url: string }> {
    if (this.flows.has(input.id)) {
      throw new Error(`flow already active for id ${input.id}`);
    }

    await fs.mkdir(path.join(input.home, ".claude"), { recursive: true });

    const env = { ...process.env, HOME: input.home };
    // Strip CLAUDECODE so the CLI doesn't refuse "cannot launch
    // inside another Claude Code session" when we run in a dev shell
    // that has it set (matches the proxy's SUBPROCESS_ENV_BASE).
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = this.spawnFn(
      this.claudeBin,
      ["auth", "login", "--claudeai"],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );

    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const donePromise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Without this, cancelling a flow whose donePromise nobody is
    // currently awaiting would surface as an unhandledRejection in
    // the runtime (and crash node:test). The submitCode caller
    // re-attaches its own awaiter and gets the same rejection.
    donePromise.catch(() => {});

    const flow: PendingFlow = {
      id: input.id,
      proc,
      url: "",
      home: input.home,
      startedAt: new Date(),
      stdoutBuf: "",
      stderrBuf: "",
      donePromise,
      resolveDone,
      rejectDone,
      codeSubmitted: false,
      timeoutHandle: setTimeout(() => {
        this._cancelInternal(
          input.id,
          new Error(`OAuth flow timed out after ${this.flowTimeoutMs}ms`),
        );
      }, this.flowTimeoutMs),
    };
    this.flows.set(input.id, flow);

    proc.stdout?.on("data", (chunk: Buffer) => {
      flow.stdoutBuf += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      flow.stderrBuf += chunk.toString();
    });
    proc.on("error", (err) => {
      this._cancelInternal(
        input.id,
        new Error(`claude spawn failed: ${err.message}`),
      );
    });
    proc.on("close", (code) => {
      clearTimeout(flow.timeoutHandle);
      // Successful exit + credentials file present is the success
      // signal. We can't await fs.access here without making the
      // exit handler async; defer the file check to the status
      // endpoint and just resolve donePromise on exit==0.
      if (code === 0) {
        flow.resolveDone();
      } else {
        flow.rejectDone(
          new Error(
            `claude auth login exited ${code}: ${flow.stderrBuf.trim() || flow.stdoutBuf.trim() || "no output"}`,
          ),
        );
      }
      this.flows.delete(input.id);
    });

    // Wait for the URL line. Bounded by 30s — if the CLI doesn't
    // print a URL by then, something's wrong with the binary or env.
    const url = await this._waitForUrl(flow, 30_000);
    flow.url = url;
    return { url };
  }

  /**
   * Pipes the user-pasted code into the held-open subprocess's stdin
   * and returns a promise that resolves when the CLI writes the
   * credentials file (or rejects on bad code / CLI error / timeout).
   *
   * Caller is expected to verify the credentials file separately
   * (parse expires_at, update DB row) — this method only resolves
   * the spawn lifecycle.
   */
  async submitCode(id: string, code: string): Promise<void> {
    const flow = this.flows.get(id);
    if (!flow) {
      throw new Error(
        `no active flow with id ${id} (timed out, completed, or never started)`,
      );
    }
    if (flow.codeSubmitted) {
      throw new Error("code already submitted for this flow");
    }
    if (!flow.proc.stdin || flow.proc.stdin.destroyed) {
      throw new Error("subprocess stdin is no longer writable");
    }
    flow.codeSubmitted = true;
    flow.proc.stdin.write(`${code.trim()}\n`);
    flow.proc.stdin.end();
    return flow.donePromise;
  }

  /**
   * Kills the subprocess and removes the flow. Idempotent — safe to
   * call from a status-endpoint timeout, an explicit user "cancel",
   * or the internal flow-timeout backstop.
   */
  cancel(id: string): void {
    this._cancelInternal(id, new Error("flow cancelled"));
  }

  private _cancelInternal(id: string, reason: Error): void {
    const flow = this.flows.get(id);
    if (!flow) return;
    clearTimeout(flow.timeoutHandle);
    try {
      if (!flow.proc.killed) flow.proc.kill("SIGTERM");
    } catch {
      /* ignore — already dead */
    }
    flow.rejectDone(reason);
    this.flows.delete(id);
  }

  /**
   * Test/introspection helper — returns the active flow ids so tests
   * can assert "no leaks". Not part of the public API.
   */
  _activeIds(): string[] {
    return [...this.flows.keys()];
  }

  private async _waitForUrl(flow: PendingFlow, timeoutMs: number): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const m = this.urlRegex.exec(flow.stdoutBuf);
      if (m) return m[0]!;
      if (!this.flows.has(flow.id)) {
        // Flow died (spawn error) before URL arrived.
        throw new Error(
          `claude auth login failed before printing URL: ${flow.stderrBuf.trim() || "no stderr"}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    this._cancelInternal(
      flow.id,
      new Error(`timed out waiting for OAuth URL after ${timeoutMs}ms`),
    );
    throw new Error(
      `claude auth login did not print a URL within ${timeoutMs}ms`,
    );
  }
}

/**
 * Process-wide singleton — the API endpoints share one driver so a
 * `start` request and the subsequent `code` request hit the same
 * in-memory map of pending flows. Tests construct their own driver
 * instances and don't go through this.
 */
let _singleton: ClaudeOAuthDriver | null = null;
export function getClaudeOAuthDriver(): ClaudeOAuthDriver {
  if (!_singleton) _singleton = new ClaudeOAuthDriver();
  return _singleton;
}
/** Reset the singleton — only for tests. */
export function _resetClaudeOAuthDriver(): void {
  _singleton = null;
}

/**
 * Reads `.credentials.json` from a finished OAuth flow's HOME and
 * returns the expiry. The CLI writes the file with several keys; the
 * exact shape varies between versions, so we accept both
 * `expiresAt` (numeric ms) and a nested `expires_at` (ISO string).
 *
 * Returns null when the file is missing or malformed — caller treats
 * that as "still pending".
 */
export async function readCredentialsExpiry(
  home: string,
): Promise<Date | null> {
  const p = path.join(home, ".claude", ".credentials.json");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Walk the JSON looking for an expires_at-shaped value. This
  // tolerates the credential blob being nested under a top-level
  // `claudeAiOauth` key (current shape) or top-level (older shape).
  const candidates: unknown[] = [];
  for (const v of Object.values(parsed)) {
    if (v && typeof v === "object") candidates.push(v);
  }
  candidates.push(parsed);
  for (const c of candidates) {
    const obj = c as Record<string, unknown>;
    const ms = typeof obj.expiresAt === "number" ? obj.expiresAt : undefined;
    if (ms) return new Date(ms);
    const iso = typeof obj.expires_at === "string" ? obj.expires_at : undefined;
    if (iso) {
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}
