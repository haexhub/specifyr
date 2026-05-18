import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { makeFsHandlers } from "../acp/fs-handlers.js";
import { acpPermissionToCapability, capabilityDecisionToAcpOutcome } from "../acp/permission-bridge.js";

/**
 * Speak ACP to a child agent over stdio. Forwards `session/update` notifications
 * verbatim through the active onEvent — TurnBroker handles them as native ACP shapes.
 *
 * Two lifecycles are supported:
 *   - One-shot via `run({ prompt, signal })`: spawn → initialize → newSession →
 *     prompt → close. Used by RunScheduler for batch tasks.
 *   - Keep-alive via `start()` + repeated `prompt(...)` + `close()`: the child
 *     process and ACP session id are reused across turns so the agent retains
 *     its in-memory conversation context. Used by TurnBroker for interactive chat.
 *
 * In keep-alive mode `cancel()` sends the ACP `session/cancel` notification and
 * keeps the child alive (the agent finishes the turn with `stopReason: cancelled`,
 * and the next prompt continues on the same session). In one-shot mode, abort
 * signals kill the child directly so `run()` rejects promptly.
 */
export class AcpRunner {
  constructor({ binary, args = [], cwd = process.cwd(), env, memoryRoot, onEvent, approvalService, slug, agent, newSessionMeta, desiredModel } = {}) {
    if (!binary) throw new Error("AcpRunner: binary is required");
    this.binary = binary;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.memoryRoot = memoryRoot;
    this.approvalService = approvalService;
    this.slug = slug;
    this.agent = agent;
    // Forwarded as `_meta` on the ACP session/new request. claude-agent-acp
    // reads `_meta.claudeCode.options.*` (see acp-agent.js: `userProvidedOptions`)
    // to set query options like `model` — there is NO CLI flag for the model
    // in the new package, so this is the only way to pin it.
    this.newSessionMeta = newSessionMeta;
    // codex-acp does NOT honor model via _meta or --model: its newSession
    // calls threadStart({ model: null }) (dist/index.js:19209) and the Rust
    // codex falls back to its hardcoded default (gpt-5.5). To override, we
    // call session/set_model after newSession with the modelId returned in
    // availableModels (format: `<name>[<effort>]`).
    this.desiredModel = desiredModel;

    this.child = null;
    this._conn = null;
    this._sessionId = null;
    this._stderr = "";
    this._childExitPromise = null;
    this._spawnErrorPromise = null;
    // Mutable ref so each prompt() call swaps in its own event sink without
    // having to rebuild the ACP connection.
    this._currentOnEvent = onEvent ?? null;
    this._closed = false;
    // After start(), reflects the agent's advertised capabilities. Callers can
    // inspect e.g. `runner.capabilities?.loadSession` to know whether the
    // session id this runner reports can be resumed after the child dies.
    this.capabilities = null;
    // True iff this runner's session was resumed via session/load rather than
    // freshly created via session/new. Exposed so callers (and tests) can tell
    // whether the agent restored prior state from its own disk persistence.
    this.resumedFromDisk = false;
  }

  /** True iff the child is spawned and hasn't exited or been closed. */
  isAlive() {
    return !!this.child && !this.child.killed && this.child.exitCode === null && !this._closed;
  }

  /**
   * Spawn the agent, run ACP `initialize` + `newSession` (or `loadSession` when
   * `resumeSessionId` is provided AND the agent advertises the capability),
   * optionally pin the model. Safe to call multiple times — no-op if already
   * alive.
   *
   * Resume contract:
   *   - When `resumeSessionId` is supplied and the agent advertises
   *     `loadSession: true`, we call session/load. On success the runner reuses
   *     that session id — the agent restores any state it persisted on its own
   *     disk (e.g. claude-agent-acp uses ~/.claude/projects/...), so no
   *     prompt-side history replay is needed.
   *   - On loadSession failure (e.g. the agent's storage was wiped because
   *     ~/.claude isn't a persistent volume) we silently fall back to
   *     newSession, which gives a clean slate. Callers should still prepend
   *     conversation history in this case — runner.resumedFromDisk tells them
   *     which path was taken.
   *   - When `resumeSessionId` is not supplied, or the agent doesn't support
   *     loadSession, we go straight to newSession as before.
   */
  async start({ resumeSessionId } = {}) {
    if (this.isAlive()) return;
    if (this._closed) throw new Error("AcpRunner: instance already closed; create a new one");

    const child = spawn(this.binary, this.args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...(this.memoryRoot ? { HERMES_HOME: this.memoryRoot } : {}),
        ...(this.env ?? {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this._stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      this._stderr += c;
      // Surface upstream agent errors (e.g. codex "unknown model", 401) to
      // server logs — otherwise they only appear in the eventual throw, and
      // not at all on the silent "(keine Antwort)" path.
      process.stderr.write(`[acp:${this.binary}] ${c}`);
    });

    // Async spawn failures (ENOENT when binary isn't on PATH, EACCES, ...)
    // arrive as an "error" event. Without a listener Node escalates them to
    // uncaughtException and crashes the host process. Capture and surface as
    // a normal rejection from start().
    this._spawnErrorPromise = new Promise((_, reject) => {
      child.once("error", (err) => {
        const detail = err.code === "ENOENT"
          ? `binary '${this.binary}' not found on PATH`
          : err.message;
        reject(Object.assign(new Error(`ACP agent spawn failed: ${detail}`), { cause: err }));
      });
    });
    // Swallow unhandled-rejection if start() exits via the happy path.
    this._spawnErrorPromise.catch(() => {});

    // Resolves with the exit code (or signal) once the child terminates. Used by
    // prompt() to detect unexpected death mid-turn.
    this._childExitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this._closed = true;
        resolve({ code, signal });
      });
    });

    // stdin EPIPE when the child dies before we finish writing the
    // initial protocol frames would otherwise also become uncaught.
    child.stdin.on("error", () => {});

    const { approvalService, slug, agent } = this;
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );

    const fsHandlers = makeFsHandlers({ cwd: this.cwd });

    this._conn = new ClientSideConnection(
      () => ({
        sessionUpdate: async ({ update }) => {
          // Identity: TurnBroker speaks ACP natively — no translation here.
          this._currentOnEvent?.(update);
        },
        async requestPermission({ sessionId, toolCall, options }) {
          // No approval service wired (or no agent context) — safe-deny.
          if (!approvalService || !agent) {
            const reject = options.find((o) => o.optionId === "reject_once") ?? options[0];
            return { outcome: { outcome: "selected", optionId: reject.optionId } };
          }
          const capability = acpPermissionToCapability({ title: toolCall.title });
          const result = await approvalService.requestApproval({
            slug,
            agent,
            capability,
            requestPayload: { toolCall, sessionId }
          });
          // requestApproval resolves to { decision, ... }; "escalated" is
          // treated as not-approved for ACP purposes (deny path).
          const decision = result?.decision === "approved" ? "approved" : "denied";
          return { outcome: capabilityDecisionToAcpOutcome(decision, options) };
        },
        async readTextFile(req) { return fsHandlers.readTextFile(req); },
        async writeTextFile(req) { return fsHandlers.writeTextFile(req); }
      }),
      stream
    );

    try {
      await Promise.race([
        this._spawnErrorPromise,
        (async () => {
          const init = await this._conn.initialize({
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }
          });
          this.capabilities = init?.agentCapabilities ?? null;

          // Try to resume a prior session on disk before creating a fresh one.
          // Conditions: caller supplied a sessionId AND the agent advertises
          // loadSession. Any failure (capability not advertised, agent error,
          // sessionId no longer on disk) falls through to newSession() — losing
          // the agent's in-memory state but keeping the turn functional.
          let resumedSession = null;
          if (resumeSessionId && this.capabilities?.loadSession) {
            try {
              await this._conn.loadSession({
                sessionId: resumeSessionId,
                cwd: this.cwd,
                mcpServers: []
              });
              this._sessionId = resumeSessionId;
              this.resumedFromDisk = true;
              // claude-agent-acp's loadSession response is empty; capture the
              // sessionId locally and skip the newSession branch entirely.
              resumedSession = { sessionId: resumeSessionId, models: null };
            } catch (err) {
              // Common reasons: ~/.claude/projects/<hash>/<sid>.jsonl was wiped
              // by a container restart on non-persistent storage, or the agent
              // rejected the id. Log once, fall through to newSession.
              process.stderr.write(
                `[acp:${this.binary}] loadSession(${resumeSessionId}) failed, falling back to newSession: ${err?.message ?? err}\n`
              );
            }
          }

          const newSession = resumedSession ?? await this._conn.newSession({
            cwd: this.cwd,
            mcpServers: [],
            ...(this.newSessionMeta ? { _meta: this.newSessionMeta } : {})
          });
          this._sessionId = newSession.sessionId;
          if (this.desiredModel && newSession.models?.availableModels?.length) {
            const wanted = this.desiredModel;
            const match = newSession.models.availableModels.find(
              (m) => m.modelId === wanted || m.modelId.startsWith(`${wanted}[`)
            );
            if (match && match.modelId !== newSession.models.currentModelId) {
              try {
                await this._conn.unstable_setSessionModel({
                  sessionId: newSession.sessionId,
                  modelId: match.modelId
                });
              } catch (err) {
                process.stderr.write(`[acp:${this.binary}] setSessionModel failed: ${err?.message ?? err}\n`);
              }
            } else if (!match) {
              process.stderr.write(
                `[acp:${this.binary}] desired model '${wanted}' not in availableModels: ${newSession.models.availableModels.map((m) => m.modelId).join(", ")}\n`
              );
            }
          }
        })()
      ]);
    } catch (err) {
      // Initialization failed — tear down so the instance can't be reused half-open.
      await this.close();
      throw err;
    }
  }

  /**
   * Send one prompt turn on the live session. `onEvent` (if provided) overrides
   * the runner's current event sink for the duration of this call only —
   * subsequent prompts revert to the previously-installed sink.
   */
  async prompt({ prompt, onEvent, signal, killChildOnAbort = false } = {}) {
    if (!prompt?.trim()) throw new Error("AcpRunner: prompt must be non-empty");
    if (!this.isAlive() || !this._conn || !this._sessionId) {
      throw new Error("AcpRunner: session is not started or has been closed");
    }

    const previousOnEvent = this._currentOnEvent;
    if (onEvent !== undefined) this._currentOnEvent = onEvent;

    let onAbort = null;
    if (signal) {
      onAbort = () => {
        // Two abort modes:
        //  - killChildOnAbort=true (one-shot via run()): force-kill the child so
        //    the prompt promise rejects promptly with an EPIPE/exit error.
        //  - killChildOnAbort=false (broker keep-alive): cooperative cancel via
        //    session/cancel — the child stays alive for the next turn, and the
        //    in-flight prompt resolves with stopReason="cancelled".
        if (killChildOnAbort) {
          if (this.child && !this.child.killed) this.child.kill("SIGTERM");
        } else {
          this.cancel();
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const promptResult = await Promise.race([
        this._spawnErrorPromise,
        this._childExitPromise.then(({ code, signal: sig }) => {
          throw new Error(`ACP agent exited unexpectedly (code=${code} signal=${sig ?? "none"})`);
        }),
        this._conn.prompt({
          sessionId: this._sessionId,
          prompt: [{ type: "text", text: prompt }]
        })
      ]);
      const stopReason = promptResult?.stopReason;
      return {
        claudeSessionId: this._sessionId,
        result: {
          type: "result",
          subtype: stopReason === "end_turn" ? "success" : "error",
          result: "",
          stopReason
        },
        exitCode: 0,
        stderr: this._stderr
      };
    } catch (err) {
      if (signal?.aborted) {
        const e = new Error("Aborted");
        e.aborted = true;
        throw e;
      }
      throw err;
    } finally {
      this._currentOnEvent = previousOnEvent;
      if (signal && onAbort) signal.removeEventListener?.("abort", onAbort);
    }
  }

  /**
   * Cooperative cancel — sends ACP `session/cancel`. The child keeps running so
   * the next prompt() can continue on the same session. The in-flight prompt()
   * (if any) resolves with stopReason="cancelled".
   */
  cancel() {
    if (this._conn && this._sessionId && this.isAlive()) {
      this._conn.cancel({ sessionId: this._sessionId }).catch(() => {});
    }
  }

  /** Tear down the child + connection. Idempotent. */
  async close() {
    this._closed = true;
    if (this.child && !this.child.killed) {
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.child = null;
    this._conn = null;
    this._sessionId = null;
  }

  /**
   * Backwards-compatible one-shot: spawn → prompt → close. Used by RunScheduler.
   * `signal` aborts via child kill (not cooperative) so callers see prompt
   * rejection without waiting for the agent to round-trip a cancel.
   */
  async run({ prompt, signal } = {}) {
    try {
      await this.start();
      return await this.prompt({ prompt, signal, killChildOnAbort: true });
    } finally {
      await this.close();
    }
  }
}
