import {
  loadSessionStore,
  loadTurnBroker,
  assertProjectExists
} from "../../../../../../../../utils/specops-stores";

interface StoredEvent {
  seq: number;
  event: string;
  data: unknown;
  ts: string;
}

/**
 * SSE subscription for a session's turn-event log. Implements gap-free log tail:
 *
 *   1. Subscribe to live events FIRST and buffer anything that arrives.
 *   2. Read every event with seq > since from disk and stream them.
 *   3. Flush the live buffer, deduped by seq.
 *   4. Continue streaming live events until the turn emits 'done' (or 'error'),
 *      or the runner ends without one.
 *
 * Without that ordering a race exists between disk read and subscription where an
 * event could land on disk after we read but before we listen — and we'd miss it.
 *
 * Wire format: each SSE message has `event: <name>` and a JSON payload of shape
 * `{ seq, data }` where `data` is the original payload. The `id:` field is set to
 * the seq so the browser's EventSource auto-reconnect carries Last-Event-ID for us.
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  const sid = getRouterParam(event, "sid");
  if (!slug || !stepId || !sid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId/sid" });
  }

  await assertProjectExists(slug);

  const sessionStore = await loadSessionStore();
  const session = await sessionStore.getSessionMeta(slug, stepId, sid);
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }

  // Last-Event-ID (set by EventSource on auto-reconnect) takes precedence over the
  // explicit ?since= query so a reconnect always picks up exactly where it dropped.
  const headerSince = getRequestHeader(event, "last-event-id");
  const querySince = (getQuery(event).since as string | undefined) ?? "0";
  const since = Number.parseInt(headerSince ?? querySince, 10) || 0;

  const broker = await loadTurnBroker();
  const emitter = broker.emitterFor(slug, stepId, sid);

  const stream = createEventStream(event);

  let highestSent = since;
  let replayDone = false;
  let closed = false;
  const buffer: StoredEvent[] = [];

  const push = async (entry: StoredEvent) => {
    if (closed) return;
    if (entry.seq <= highestSent) return;
    highestSent = entry.seq;
    try {
      await stream.push({
        id: String(entry.seq),
        event: entry.event,
        data: JSON.stringify({ seq: entry.seq, data: entry.data })
      });
    } catch {
      /* stream closed by client */
    }
  };

  // (1) Subscribe FIRST — before disk read — so live events that arrive during
  // replay are buffered, not dropped.
  const onLive = (entry: StoredEvent) => {
    if (!replayDone) {
      buffer.push(entry);
    } else {
      void push(entry).then(() => {
        // If this was the terminal event for the turn, close cleanly so the client
        // sees the stream end naturally and knows the turn is over.
        if (entry.event === "done" || entry.event === "turn_failed") {
          closed = true;
          stream.close().catch(() => {});
        }
      });
    }
  };
  const onEnded = () => {
    // Runner finished and broker dropped its handle. If we haven't seen a 'done'
    // event for some reason, close anyway so the client doesn't hang.
    if (!closed) {
      closed = true;
      stream.close().catch(() => {});
    }
  };
  emitter.on("event", onLive);
  emitter.on("ended", onEnded);

  stream.onClosed(() => {
    closed = true;
    emitter.off("event", onLive);
    emitter.off("ended", onEnded);
  });

  // (2) Disk replay.
  const diskEvents = (await sessionStore.readEventsSince(slug, stepId, sid, since)) as StoredEvent[];
  for (const e of diskEvents) {
    await push(e);
  }
  replayDone = true;

  // (3) Flush buffered live events, deduplicated against what disk replay already sent.
  while (buffer.length > 0) {
    const e = buffer.shift()!;
    await push(e);
    if (e.event === "done" || e.event === "turn_failed") {
      closed = true;
      await stream.close().catch(() => {});
      break;
    }
  }

  // (4) If no turn is running for this session, the disk replay was the entire story.
  // Close so the client doesn't sit waiting forever.
  if (!closed && !broker.isRunning(slug, stepId, sid)) {
    closed = true;
    await stream.close().catch(() => {});
  }

  return stream.send();
});
