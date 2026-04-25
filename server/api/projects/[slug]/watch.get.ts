import path from "node:path";
import { projectCwd, assertProjectExists } from "../../../utils/specops-stores";

/**
 * Server-Sent Events stream that emits whenever a file inside the project's
 * `.specify/` directory changes. Client-side ArtifactViewer listens and
 * triggers a refetch so the pane stays in sync with external edits.
 *
 * Events:
 *   - type "change"  : a watched file was added/modified/removed
 *   - type "ready"   : initial scan finished
 *   - type "error"   : watcher error (non-fatal; stream stays open)
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) throw createError({ statusCode: 400, statusMessage: "Missing slug" });

  await assertProjectExists(slug);

  const chokidar = await import("chokidar");
  const specifyDir = path.join(projectCwd(slug), ".specify");

  const watcher = chokidar.watch(specifyDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });

  const stream = createEventStream(event);

  const safePush = async (name: string, payload: unknown) => {
    try {
      await stream.push({ event: name, data: JSON.stringify(payload) });
    } catch {
      /* stream closed */
    }
  };

  const makeRel = (full: string) => path.relative(projectCwd(slug), full);

  watcher
    .on("ready", () => safePush("ready", { watched: specifyDir }))
    .on("add", (p: string) => safePush("change", { kind: "add", path: makeRel(p) }))
    .on("change", (p: string) => safePush("change", { kind: "change", path: makeRel(p) }))
    .on("unlink", (p: string) => safePush("change", { kind: "unlink", path: makeRel(p) }))
    .on("error", (err: unknown) =>
      safePush("error", { message: err instanceof Error ? err.message : String(err) })
    );

  // Firefox (and intermediary proxies) close idle EventSource connections. After the initial
  // `ready` event the watcher may sit silent for minutes until a file actually changes, which
  // trips the idle timeout and logs "Verbindung … unterbrochen" in the browser console on
  // every reconnect. A periodic heartbeat (sent as an SSE comment so clients don't see it
  // as an event) keeps the connection warm.
  const heartbeat = setInterval(() => {
    safePush("heartbeat", { ts: Date.now() });
  }, 20_000);

  stream.onClosed(async () => {
    clearInterval(heartbeat);
    await watcher.close();
  });

  return stream.send();
});
