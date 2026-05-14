import path from "node:path";
import { projectCwd, assertProjectExists } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";

/**
 * Server-Sent Events stream that emits whenever a file inside the project's
 * `.specify/` or `.specifyr/` directories changes. Client-side ArtifactViewer
 * listens and triggers a refetch so the pane stays in sync with external edits.
 *
 * Events:
 *   - type "change"  : a watched file was added/modified/removed
 *   - type "ready"   : initial scan finished
 *   - type "error"   : watcher error (non-fatal; stream stays open)
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) throw createError({ statusCode: 400, statusMessage: "Missing slug" });

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  await assertProjectExists(orgId, slug);

  const chokidar = await import("chokidar");
  const projectDir = projectCwd(orgId, slug);

  // Watch the project root so the watcher is always anchored to an existing directory.
  // Filtering to .specify/ and .specifyr/ avoids noise from unrelated files (git, code, etc.).
  // Without this, chokidar on Linux (inotify) silently fails when .specify/ doesn't exist yet.
  const watcher = chokidar.watch(projectDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: (filePath: string) => {
      if (filePath === projectDir) return false;
      const rel = path.relative(projectDir, filePath);
      return !rel.startsWith(".specify") && !rel.startsWith(".specifyr");
    }
  });

  const stream = createEventStream(event);

  const safePush = async (name: string, payload: unknown) => {
    try {
      await stream.push({ event: name, data: JSON.stringify(payload) });
    } catch {
      /* stream closed */
    }
  };

  const makeRel = (full: string) => path.relative(projectDir, full);

  watcher
    .on("ready", () => safePush("ready", { watched: projectDir }))
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
