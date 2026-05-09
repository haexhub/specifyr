import { EventEmitter } from "node:events";

const CONTEXT_MESSAGES_ON_RESET = 10;

/**
 * Per-process singleton that owns the lifecycle of in-flight chat turns.
 *
 * Design contract:
 *   - The DISK is the single source of truth. Every event the runner emits is
 *     written to `.specifyr/<slug>/steps/<stepId>/sessions/<sid>.events.jsonl`.
 *   - The broker holds only two things in memory:
 *       1. `running`: a Map of sessionKey → live runner handle (so we can cancel)
 *       2. `emitters`: a Map of sessionKey → EventEmitter (notification only —
 *          the EVENT PAYLOADS themselves never sit in memory beyond the moment
 *          of emission). Subscribers re-read disk for any payload they need.
 *   - `runner.cancel()` is NEVER called from a client-disconnect handler. The
 *     turn runs to completion regardless of whether anyone is watching.
 */

function keyFor(slug, stepId, sid) {
  return `${slug}|${stepId}|${sid}`;
}

export class TurnBroker {
  constructor({ sessionStore, runnerFactory }) {
    this.sessionStore = sessionStore;
    this.runnerFactory = runnerFactory;
    this.running = new Map();
    this.emitters = new Map();
  }

  /** Get-or-create the EventEmitter for a session. Cheap (just listener list). */
  emitterFor(slug, stepId, sid) {
    const key = keyFor(slug, stepId, sid);
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

  isRunning(slug, stepId, sid) {
    return this.running.has(keyFor(slug, stepId, sid));
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
  async startTurn({ slug, stepId, sid, prompt, cwd, claudeSessionId, runnerFactory }) {
    const key = keyFor(slug, stepId, sid);
    if (this.running.has(key)) {
      throw new Error("Turn already running for this session");
    }

    let seq = await this.sessionStore.getLastEventSeq(slug, stepId, sid);
    const startSeq = seq;
    const emitter = this.emitterFor(slug, stepId, sid);

    const append = async (eventName, data) => {
      seq += 1;
      const entry = { seq, event: eventName, data, ts: new Date().toISOString() };
      await this.sessionStore.appendEvent(slug, stepId, sid, entry);
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

    // Mutable ref so cancel() always targets the currently-running child process,
    // even after a session-expiry retry spawns a new runner.
    const makeRunner = runnerFactory ?? this.runnerFactory;
    let activeRunner = await makeRunner({ cwd, onEvent });

    // Mark the boundary between "before this turn" and "this turn's events". Clients
    // reconnecting to a running session use this as the `since` cursor so they replay
    // exactly the in-flight turn's events (and nothing earlier).
    await this.sessionStore.updateSessionMeta(slug, stepId, sid, {
      status: "running",
      runningSinceSeq: startSeq
    });

    const promise = (async () => {
      try {
        let result = await activeRunner.run({
          prompt,
          resumeSessionId: claudeSessionId ?? undefined
        });

        // is_error=true means Claude Code itself reported a failure (e.g. expired --resume
        // ID, API error). exitCode !== 0 without a result event is also a hard failure.
        const isError = result.result?.is_error === true || result.exitCode !== 0;
        if (isError && !assistantText.trim()) {
          const errors = result.result?.errors ?? [];

          // "No conversation found" = the --resume target expired (Claude's session cache has
          // a short TTL). Auto-retry once without --resume so the turn succeeds. The user
          // sees a notice; Claude loses previous context but the turn completes normally.
          if (claudeSessionId && errors.some((e) => /no conversation found/i.test(String(e)))) {
            await this.sessionStore.setClaudeSessionId(slug, stepId, sid, null);

            const recentMessages = await this.sessionStore.listMessages(slug, stepId, sid);
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
            activeRunner = await makeRunner({ cwd, onEvent });
            result = await activeRunner.run({ prompt: retryPrompt });
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
          await this.sessionStore.setClaudeSessionId(slug, stepId, sid, result.claudeSessionId);
        }

        const finalText =
          assistantText.trim() ||
          (typeof result.result?.result === "string" ? result.result.result : "") ||
          "(keine Antwort)";

        const persistedMsg = await this.sessionStore.appendMessage(slug, stepId, sid, {
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
        await this.sessionStore.updateSessionMeta(slug, stepId, sid, {
          status: "completed",
          runningSinceSeq: null
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Persist any partial text the user already saw so they don't lose context.
        if (assistantText.trim()) {
          await this.sessionStore.appendMessage(slug, stepId, sid, {
            role: "assistant",
            content: assistantText.trim(),
            metadata: { failed: true, error: message, partial: true }
          });
        }
        // Renamed from "error" because the EventSource DOM API treats an "error"-named
        // event ambiguously (also used for connection drops). Clients listen for
        // "turn_failed" specifically.
        await append("turn_failed", { message });
        await this.sessionStore.updateSessionMeta(slug, stepId, sid, {
          status: "failed",
          runningSinceSeq: null
        });
      } finally {
        this.running.delete(key);
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
  cancel(slug, stepId, sid) {
    const state = this.running.get(keyFor(slug, stepId, sid));
    if (state) state.runner.cancel();
  }
}
