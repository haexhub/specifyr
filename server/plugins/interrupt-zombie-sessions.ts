import { loadSessionStore } from "../utils/specifyr-stores";

/**
 * Nitro startup plugin. Walks every persisted session whose status was "running" at
 * the time of the previous process death and demotes it to "interrupted" so the UI
 * never shows a permanently-stuck "running" session.
 *
 * The Claude subprocess that owned each interrupted turn is gone (it died with the
 * parent process). Resumption is a deliberate user action — we surface a "retry"
 * affordance in the UI for interrupted sessions, and the retry uses Claude's
 * `--resume <claudeSessionId>` mechanism to continue the conversation.
 */
export default defineNitroPlugin(async () => {
  try {
    const store = await loadSessionStore();
    const interrupted = await store.interruptRunningSessions();
    if (interrupted.length > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[turn-broker] Marked ${interrupted.length} stuck "running" session(s) as "interrupted" after restart.`
      );
    }
  } catch (err) {
    // Failing here would prevent the server from starting — bad trade. Log and continue;
    // worst case, a few sessions show "running" until the user manually retries.
    // eslint-disable-next-line no-console
    console.warn("[turn-broker] Zombie cleanup failed:", err);
  }
});
