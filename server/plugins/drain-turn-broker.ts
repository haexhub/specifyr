import { loadTurnBroker } from "../shared/utils/specifyr-stores";

/**
 * Drain every cached keep-alive ACP runner on Nitro shutdown.
 *
 * Without this, each interactive chat session's child `claude-agent-acp`
 * subprocess would survive past the parent's exit (since they're detached over
 * stdio pipes, not ptrace) and accumulate as zombies over dev HMR cycles.
 *
 * In-flight TURNS are intentionally NOT cancelled here — the broker's contract
 * is that a turn runs to completion regardless of who's watching. closeAll()
 * only closes IDLE cached sessions; live turns finish their in-flight prompt()
 * and then the child gets SIGTERM'd because `close()` on the broker side races
 * the close hook's process-exit.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("close", async () => {
    try {
      const broker = await loadTurnBroker();
      await broker.closeAllSessions?.();
    } catch (err) {
      // Best-effort — Nitro is already tearing down.
      // eslint-disable-next-line no-console
      console.warn("[turn-broker] closeAllSessions failed during shutdown:", err);
    }
  });
});
