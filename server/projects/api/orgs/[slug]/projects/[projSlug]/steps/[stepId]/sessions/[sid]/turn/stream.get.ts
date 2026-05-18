import {
  loadSessionStore,
  loadTurnBroker,
  assertProjectExists
} from "@su/specifyr-stores";

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
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const stepId = getRouterParam(event, "stepId");
  const sid = getRouterParam(event, "sid");
  if (!stepId || !sid) {
    throw createError({ statusCode: 400, statusMessage: "Missing stepId/sid" });
  }

  await assertProjectExists(orgId, slug);

  const sessionStore = await loadSessionStore();
  const session = await sessionStore.getSessionMeta(orgId, slug, stepId, sid);
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }

  // Last-Event-ID (set by EventSource on auto-reconnect) takes precedence over the
  // explicit ?since= query so a reconnect always picks up exactly where it dropped.
  const headerSince = getRequestHeader(event, "last-event-id");
  const querySince = (getQuery(event).since as string | undefined) ?? "0";
  const since = Number.parseInt(headerSince ?? querySince, 10) || 0;

  const broker = await loadTurnBroker();
  const emitter = broker.emitterFor(orgId, slug, stepId, sid);

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

  // Disk replay + live-buffer flush + idle-close run in the background.
  // Doing them in the foreground deadlocks: createEventStream uses a
  // TransformStream whose readable side is only consumed once stream.send()
  // returns the stream to h3's sendStream(). Default queuing strategy has
  // HWM=1, so writer.write() (driven by stream.push) backpressure-blocks on
  // the second write — and we never reach `return stream.send()` because
  // we're still awaiting that push. Symptom: SSE connection stays open but
  // emits zero bytes (curl times out, EventSource never receives anything).
  void (async () => {
    try {
      // (2) Disk replay.
      const diskEvents = (await sessionStore.readEventsSince(
        orgId,
        slug,
        stepId,
        sid,
        since,
      )) as StoredEvent[];
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
          return;
        }
      }

      // (4) If no turn is running for this session, the disk replay was the entire story.
      // Push a terminal event if the session is interrupted so the client stops its spinner,
      // then close. Without the event the client's EventSource reconnects forever.
      if (!closed && !broker.isRunning(orgId, slug, stepId, sid)) {
        if (session.status === "interrupted") {
          await stream.push({
            event: "turn_failed",
            data: JSON.stringify({
              seq: highestSent + 1,
              data: { message: "interrupted" },
            }),
          }).catch(() => {});
        }
        closed = true;
        await stream.close().catch(() => {});
      }
    } catch (err) {
      process.stderr.write(
        `[turn/stream] background work failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      closed = true;
      await stream.close().catch(() => {});
    }
  })();

  return stream.send();
});
