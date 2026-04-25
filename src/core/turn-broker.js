import { EventEmitter } from "node:events";

/**
 * Per-process singleton that owns the lifecycle of in-flight chat turns.
 *
 * Design contract:
 *   - The DISK is the single source of truth. Every event the runner emits is
 *     written to `.specops/<slug>/steps/<stepId>/sessions/<sid>.events.jsonl`.
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
  async startTurn({ slug, stepId, sid, prompt, cwd, claudeSessionId }) {
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

    const runner = this.runnerFactory({
      cwd,
      onEvent: async (claudeEvent) => {
        if (claudeEvent?.type === "assistant" && Array.isArray(claudeEvent.message?.content)) {
          for (const block of claudeEvent.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              if (toolUseSinceLastText && assistantText) {
                assistantText += `\n\n${block.text}`;
              } else {
                assistantText += block.text;
              }
              toolUseSinceLastText = false;
            } else if (block?.type === "tool_use" && block.name) {
              toolUses.push({ name: block.name, input: block.input });
              toolUseSinceLastText = true;
            }
          }
        }
        await append("claude", claudeEvent);
      }
    });

    // Mark the boundary between "before this turn" and "this turn's events". Clients
    // reconnecting to a running session use this as the `since` cursor so they replay
    // exactly the in-flight turn's events (and nothing earlier).
    await this.sessionStore.updateSessionMeta(slug, stepId, sid, {
      status: "running",
      runningSinceSeq: startSeq
    });

    const promise = (async () => {
      try {
        const result = await runner.run({
          prompt,
          resumeSessionId: claudeSessionId ?? undefined
        });

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

    this.running.set(key, { runner, promise });
    return { startSeq };
  }

  /** Manually cancel a running turn (e.g. user pressed "stop"). */
  cancel(slug, stepId, sid) {
    const state = this.running.get(keyFor(slug, stepId, sid));
    if (state) state.runner.cancel();
  }
}
