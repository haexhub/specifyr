import { EventEmitter } from "node:events";

const CONTEXT_MESSAGES_ON_RESET = 10;
// Default idle window before a cached keep-alive runner is closed. 30 min matches
// the typical interactive-chat dwell time; subsequent turns within this window
// reuse the same ACP session (so the agent keeps its in-memory context).
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Per-process singleton that owns the lifecycle of in-flight chat turns AND of
 * the persistent ACP runner that those turns share.
 *
 * Design contract:
 *   - The DISK is the single source of truth for *messages*. Every event the
 *     runner emits is written to `.specifyr/<slug>/steps/<stepId>/sessions/<sid>.events.jsonl`.
 *   - In-memory state is exactly:
 *       1. `running`: sessionKey → live runner handle for the *current turn*
 *          (so cancel() can reach it).
 *       2. `emitters`: sessionKey → EventEmitter (notification only — event
 *          payloads do not sit in memory beyond emission).
 *       3. `sessions`: sessionKey → { runner, idleTimer } for keep-alive runners
 *          that survive across turns so the agent retains conversation context
 *          inside its own process. Closed by idle timeout, on child death, or
 *          on `closeAll()` (server shutdown).
 *   - `runner.cancel()` is NEVER called from a client-disconnect handler. The
 *     turn runs to completion regardless of whether anyone is watching.
 */

function keyFor(orgId, slug, stepId, sid) {
  return `${orgId}|${slug}|${stepId}|${sid}`;
}

export class TurnBroker {
  constructor({ sessionStore, runnerFactory, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS }) {
    this.sessionStore = sessionStore;
    this.runnerFactory = runnerFactory;
    this.running = new Map();
    this.emitters = new Map();
    this.sessions = new Map();
    this.idleTimeoutMs = idleTimeoutMs;
  }

  /** Get-or-create the EventEmitter for a session. Cheap (just listener list). */
  emitterFor(orgId, slug, stepId, sid) {
    const key = keyFor(orgId, slug, stepId, sid);
    let e = this.emitters.get(key);
    if (!e) {
      e = new EventEmitter();
      // Multiple browser tabs / re-subscriptions can happen concurrently. Default 10
      // is too tight; 100 is comfortably above any sane real-world subscriber count.
      e.setMaxListeners(100);
      this.emitters.set(key, e);
    }
    return e;
  }

  isRunning(orgId, slug, stepId, sid) {
    return this.running.has(keyFor(orgId, slug, stepId, sid));
  }

  /**
   * True iff a keep-alive runner is currently cached for this session AND its
   * child process is still alive. Callers use this to decide whether the next
   * prompt needs to re-inject conversation history (after restart / idle /
   * crash) or can rely on the agent's in-process memory.
   */
  hasLiveSession(orgId, slug, stepId, sid) {
    const state = this.sessions.get(keyFor(orgId, slug, stepId, sid));
    return !!(state && typeof state.runner.isAlive === "function" && state.runner.isAlive());
  }

  _clearIdleTimer(state) {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  _armIdleTimer(key) {
    const state = this.sessions.get(key);
    if (!state) return;
    this._clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      this._closeSession(key).catch(() => {});
    }, this.idleTimeoutMs);
    // Don't hold the event loop open just to fire cleanup.
    state.idleTimer.unref?.();
  }

  async _closeSession(key) {
    const state = this.sessions.get(key);
    if (!state) return;
    this.sessions.delete(key);
    this._clearIdleTimer(state);
    if (typeof state.runner.close === "function") {
      await state.runner.close().catch(() => {});
    }
  }

  /** Drain every cached keep-alive runner. Call from Nitro shutdown hook. */
  async closeAllSessions() {
    const keys = [...this.sessions.keys()];
    await Promise.allSettled(keys.map((k) => this._closeSession(k)));
  }

  /**
   * Resolve the runner to use for this turn.
   *   - If a live keep-alive runner is cached → reuse it (and disarm its idle timer).
   *   - If a dead one is cached → drop it and create a fresh one.
   *   - If the factory's runner exposes `start()` → treat as keep-alive: start
   *     once, cache for follow-up turns.
   *   - Otherwise (legacy / test fakes with only `run()`) → return uncached, caller
   *     uses the one-shot `run()` path.
   */
  async _resolveRunner({ key, runnerFactory, cwd, onEvent, resumeSessionId }) {
    const cached = this.sessions.get(key);
    if (cached) {
      this._clearIdleTimer(cached);
      if (typeof cached.runner.isAlive === "function" && cached.runner.isAlive()) {
        return { runner: cached.runner, keepAlive: true };
      }
      this.sessions.delete(key);
      if (typeof cached.runner.close === "function") {
        await cached.runner.close().catch(() => {});
      }
    }

    const makeRunner = runnerFactory ?? this.runnerFactory;
    const runner = await makeRunner({ cwd, onEvent });
    if (typeof runner.start === "function" && typeof runner.prompt === "function") {
      try {
        // Pass the persisted session id so the runner can try ACP session/load
        // before falling back to newSession. The runner is responsible for
        // detecting capability + handling failure; we just supply the id.
        await runner.start({ resumeSessionId });
      } catch (err) {
        if (typeof runner.close === "function") await runner.close().catch(() => {});
        throw err;
      }
      this.sessions.set(key, { runner, idleTimer: null });
      return { runner, keepAlive: true };
    }
    return { runner, keepAlive: false };
  }

  /**
   * Kick off a turn. Returns once the runner is spawned, NOT when it finishes —
   * the run continues in the background. Throws if a turn for this session is
   * already in flight (caller should return 409).
   *
   * @returns {Promise<{startSeq: number}>} — the seq value BEFORE the new turn began.
   *          Clients pass this as `since` to the stream endpoint to receive every
   *          event from this turn (and nothing earlier).
   */
  async startTurn({ orgId, slug, stepId, sid, prompt, cwd, claudeSessionId, runnerFactory }) {
    const key = keyFor(orgId, slug, stepId, sid);
    if (this.running.has(key)) {
      throw new Error("Turn already running for this session");
    }

    let seq = await this.sessionStore.getLastEventSeq(orgId, slug, stepId, sid);
    const startSeq = seq;
    const emitter = this.emitterFor(orgId, slug, stepId, sid);

    const append = async (eventName, data) => {
      seq += 1;
      const entry = { seq, event: eventName, data, ts: new Date().toISOString() };
      await this.sessionStore.appendEvent(orgId, slug, stepId, sid, entry);
      emitter.emit("event", entry);
      return entry;
    };

    // Same text/tool-use bookkeeping as before, so the persisted assistant message
    // reads cleanly when text blocks are interleaved with tool calls.
    let assistantText = "";
    let toolUseSinceLastText = false;
    const toolUses = [];

    const onEvent = async (update) => {
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        if (toolUseSinceLastText && assistantText) {
          assistantText += `\n\n${update.content.text}`;
        } else {
          assistantText += update.content.text;
        }
        toolUseSinceLastText = false;
      } else if (update?.sessionUpdate === "tool_call") {
        toolUses.push({ name: update.title, input: update.rawInput });
        toolUseSinceLastText = true;
      }
      await append("session_update", update);
    };

    let { runner: activeRunner, keepAlive } = await this._resolveRunner({
      key,
      runnerFactory,
      cwd,
      onEvent,
      resumeSessionId: claudeSessionId ?? undefined
    });

    // Mark the boundary between "before this turn" and "this turn's events". Clients
    // reconnecting to a running session use this as the `since` cursor so they replay
    // exactly the in-flight turn's events (and nothing earlier).
    await this.sessionStore.updateSessionMeta(orgId, slug, stepId, sid, {
      status: "running",
      runningSinceSeq: startSeq
    });

    const promise = (async () => {
      try {
        let result;
        if (keepAlive) {
          // Keep-alive: pass the per-turn onEvent to override whatever was
          // installed at factory time, and DO NOT pass resumeSessionId — the
          // child already holds the session in process memory.
          result = await activeRunner.prompt({ prompt, onEvent });
        } else {
          result = await activeRunner.run({
            prompt,
            resumeSessionId: claudeSessionId ?? undefined
          });
        }

        // is_error=true means the agent itself reported a failure (e.g. expired
        // --resume id, API error). exitCode !== 0 without a result event is also
        // a hard failure.
        const isError = result.result?.is_error === true || result.exitCode !== 0;
        if (isError && !assistantText.trim()) {
          const errors = result.result?.errors ?? [];

          // "No conversation found" = the resume target expired (some agents have
          // a short session cache TTL). Auto-retry once without resume so the
          // turn succeeds; the user sees a notice; the agent loses prior context
          // but the turn completes normally.
          if (claudeSessionId && errors.some((e) => /no conversation found/i.test(String(e)))) {
            await this.sessionStore.setClaudeSessionId(orgId, slug, stepId, sid, null);

            const recentMessages = await this.sessionStore.listMessages(orgId, slug, stepId, sid);
            const contextMessages = recentMessages.slice(-CONTEXT_MESSAGES_ON_RESET);
            let retryPrompt = prompt;
            if (contextMessages.length > 0) {
              const history = contextMessages
                .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
                .join("\n\n");
              retryPrompt = `[Vorheriger Gesprächsverlauf — Session nach Ablauf wiederhergestellt]\n\n${history}\n\n---\n\n${prompt}`;
            }

            await append("session_reset", {
              message: "Session abgelaufen — Kontext aus Verlauf wiederhergestellt."
            });
            assistantText = "";
            toolUseSinceLastText = false;
            toolUses.splice(0);
            // Drop the dead cached session so _resolveRunner spawns a fresh child.
            await this._closeSession(key);
            const resolved = await this._resolveRunner({ key, runnerFactory, cwd, onEvent });
            activeRunner = resolved.runner;
            keepAlive = resolved.keepAlive;
            result = keepAlive
              ? await activeRunner.prompt({ prompt: retryPrompt, onEvent })
              : await activeRunner.run({ prompt: retryPrompt });
          }
        }

        // Re-evaluate after possible retry.
        const isErrorFinal = result.result?.is_error === true || result.exitCode !== 0;
        if (isErrorFinal && !assistantText.trim()) {
          const errors = result.result?.errors ?? [];
          const detail =
            (errors.length > 0 ? errors.join("; ") : null) ||
            result.stderr?.trim().slice(0, 300) ||
            `exit code ${result.exitCode}`;
          throw new Error(detail);
        }

        if (result.claudeSessionId) {
          await this.sessionStore.setClaudeSessionId(orgId, slug, stepId, sid, result.claudeSessionId);
        }

        const finalText =
          assistantText.trim() ||
          (typeof result.result?.result === "string" ? result.result.result : "") ||
          "(keine Antwort)";

        const persistedMsg = await this.sessionStore.appendMessage(orgId, slug, stepId, sid, {
          role: "assistant",
          content: finalText,
          metadata: {
            claudeSessionId: result.claudeSessionId,
            toolUses,
            cost: result.result?.total_cost_usd,
            exitCode: result.exitCode
          }
        });

        await append("assistant_message", persistedMsg);
        await append("done", {
          cost: result.result?.total_cost_usd,
          exitCode: result.exitCode
        });
        await this.sessionStore.updateSessionMeta(orgId, slug, stepId, sid, {
          status: "completed",
          runningSinceSeq: null
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Persist any partial text the user already saw so they don't lose context.
        if (assistantText.trim()) {
          await this.sessionStore.appendMessage(orgId, slug, stepId, sid, {
            role: "assistant",
            content: assistantText.trim(),
            metadata: { failed: true, error: message, partial: true }
          });
        }
        // Renamed from "error" because the EventSource DOM API treats an "error"-named
        // event ambiguously (also used for connection drops). Clients listen for
        // "turn_failed" specifically.
        await append("turn_failed", { message });
        await this.sessionStore.updateSessionMeta(orgId, slug, stepId, sid, {
          status: "failed",
          runningSinceSeq: null
        });
        // If the cached child died mid-turn, drop the entry so the next turn
        // spawns a fresh one. Live sessions keep their cache so the next turn
        // reuses them.
        if (keepAlive && typeof activeRunner.isAlive === "function" && !activeRunner.isAlive()) {
          await this._closeSession(key);
        }
      } finally {
        this.running.delete(key);
        // Arm the idle timer for cached keep-alive runners (only those still
        // alive after the turn). One-shot runners are already closed by run().
        if (keepAlive && this.sessions.has(key)) {
          this._armIdleTimer(key);
        }
        // 'ended' tells subscribers "no more live events" so they can stop waiting.
        // We keep the emitter around — same key may host another turn later.
        emitter.emit("ended");
      }
    })();

    // Store a proxy so cancel() always reaches the current active runner,
    // even if a session-expiry retry replaced it with a new instance.
    this.running.set(key, { get runner() { return activeRunner; }, promise });
    return { startSeq };
  }

  /** Manually cancel a running turn (e.g. user pressed "stop"). */
  cancel(orgId, slug, stepId, sid) {
    const state = this.running.get(keyFor(orgId, slug, stepId, sid));
    if (state) state.runner.cancel();
  }
}
