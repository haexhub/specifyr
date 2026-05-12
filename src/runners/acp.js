import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { makeFsHandlers } from "../acp/fs-handlers.js";
import { acpPermissionToCapability, capabilityDecisionToAcpOutcome } from "../acp/permission-bridge.js";

/**
 * Speak ACP to a child agent over stdio. Forwards `session/update` notifications
 * verbatim through onEvent — TurnBroker handles them as native ACP shapes.
 *
 * Drop-in compatible with the `{ run, cancel }` shape that TurnBroker
 * (turn-broker.js:104) and RunScheduler (run-scheduler.js:64) expect.
 */
export class AcpRunner {
  constructor({ binary, args = [], cwd = process.cwd(), env, memoryRoot, onEvent, approvalService, slug, agent, newSessionMeta, desiredModel } = {}) {
    if (!binary) throw new Error("AcpRunner: binary is required");
    this.binary = binary;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.memoryRoot = memoryRoot;
    this.onEvent = onEvent;
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
  }

  async run({ prompt, signal } = {}) {
    if (!prompt?.trim()) throw new Error("AcpRunner: prompt must be non-empty");

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
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr += c;
      // Surface upstream agent errors (e.g. codex "unknown model", 401) to
      // server logs — otherwise they only appear in the eventual throw, and
      // not at all on the silent "(keine Antwort)" path.
      process.stderr.write(`[acp:${this.binary}] ${c}`);
    });

    // Async spawn failures (ENOENT when binary isn't on PATH, EACCES, ...)
    // arrive as an "error" event. Without a listener Node escalates them to
    // uncaughtException and crashes the host process. Capture and surface as
    // a normal rejection from run().
    const spawnErrorPromise = new Promise((_, reject) => {
      child.once("error", (err) => {
        const detail = err.code === "ENOENT"
          ? `binary '${this.binary}' not found on PATH`
          : err.message;
        reject(Object.assign(new Error(`ACP agent spawn failed: ${detail}`), { cause: err }));
      });
    });
    // Swallow unhandled-rejection if run() exits via the happy path.
    spawnErrorPromise.catch(() => {});

    // stdin EPIPE when the child dies before we finish writing the
    // initial protocol frames would otherwise also become uncaught.
    child.stdin.on("error", () => {});

    const onEvent = this.onEvent;
    const { approvalService, slug, agent } = this;
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );

    const fsHandlers = makeFsHandlers({ cwd: this.cwd });

    const conn = new ClientSideConnection(
      () => ({
        async sessionUpdate({ update }) {
          // Identity: TurnBroker speaks ACP natively — no translation here.
          onEvent?.(update);
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

    const onAbort = () => { if (this.child && !this.child.killed) this.child.kill("SIGTERM"); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const promptResult = await Promise.race([
        spawnErrorPromise,
        (async () => {
          await conn.initialize({
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }
          });
          const newSession = await conn.newSession({
            cwd: this.cwd,
            mcpServers: [],
            ...(this.newSessionMeta ? { _meta: this.newSessionMeta } : {})
          });
          if (this.desiredModel && newSession.models?.availableModels?.length) {
            const wanted = this.desiredModel;
            const match = newSession.models.availableModels.find(
              (m) => m.modelId === wanted || m.modelId.startsWith(`${wanted}[`)
            );
            if (match && match.modelId !== newSession.models.currentModelId) {
              try {
                await conn.unstable_setSessionModel({
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
          return conn.prompt({
            sessionId: newSession.sessionId,
            prompt: [{ type: "text", text: prompt }]
          });
        })()
      ]);
      child.kill();
      return {
        claudeSessionId: null,
        result: {
          type: "result",
          subtype: promptResult.stopReason === "end_turn" ? "success" : "error",
          result: ""
        },
        exitCode: 0,
        stderr
      };
    } catch (err) {
      if (signal?.aborted) {
        const e = new Error("Aborted");
        e.aborted = true;
        throw e;
      }
      throw err;
    } finally {
      this.child = null;
    }
  }

  cancel() {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }
}
