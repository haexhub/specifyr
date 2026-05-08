import { pruneExpiredRunnerSessions } from "../utils/runner-sessions-store";

const PRUNE_INTERVAL_MS = 15 * 60 * 1000; // 15 min

/**
 * Nitro startup plugin: periodically hard-deletes runner_sessions rows
 * whose expires_at + 24h grace has passed. Without this, the table grows
 * unbounded since the lookup path only soft-rejects expired tokens.
 *
 * The interval is started after a delayed first tick so the very first
 * server start doesn't block on a delete query, and cleared on Nitro
 * shutdown so dev HMR doesn't leak handles.
 */
export default defineNitroPlugin((nitroApp) => {
  const tick = async () => {
    try {
      const removed = await pruneExpiredRunnerSessions();
      if (removed > 0) {
        console.info(
          `[runner-sessions] pruned ${removed} expired session(s)`,
        );
      }
    } catch (err) {
      console.warn("[runner-sessions] prune failed:", err);
    }
  };

  const handle = setInterval(tick, PRUNE_INTERVAL_MS);
  // Don't keep the event loop alive just for the prune timer.
  if (typeof handle.unref === "function") handle.unref();

  nitroApp.hooks.hook("close", () => {
    clearInterval(handle);
  });
});
