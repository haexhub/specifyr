import test from "node:test";
import assert from "node:assert/strict";

import { CompositeTransport } from "../../src/transports/composite.js";

function recordingTransport() {
  const calls = [];
  return {
    calls,
    async notify(payload) {
      calls.push(payload);
    },
  };
}

test("CompositeTransport: routes channel name to the right underlying transport", async () => {
  const tg = recordingTransport();
  const sig = recordingTransport();
  const c = new CompositeTransport({ telegram: tg, signal: sig });

  await c.notify({
    channel: "telegram",
    payload: { requestId: "1", slug: "s", agent: "a", capability: "c", requestedAt: "t" },
  });
  assert.equal(tg.calls.length, 1);
  assert.equal(sig.calls.length, 0);

  await c.notify({
    channel: "signal",
    payload: { requestId: "2", slug: "s", agent: "a", capability: "c", requestedAt: "t" },
  });
  assert.equal(tg.calls.length, 1);
  assert.equal(sig.calls.length, 1);
});

test("CompositeTransport: throws on unknown channel (caller can catch via emit('transport-error'))", async () => {
  const c = new CompositeTransport({ telegram: recordingTransport() });
  await assert.rejects(
    () => c.notify({ channel: "smoke-signal", payload: {} }),
    /no transport configured for channel.*smoke-signal/,
  );
});

test("CompositeTransport: empty config throws on any channel", async () => {
  const c = new CompositeTransport({});
  await assert.rejects(
    () => c.notify({ channel: "telegram", payload: {} }),
    /no transport configured/,
  );
});

test("CompositeTransport: forwards payload verbatim (no mutation)", async () => {
  const tg = recordingTransport();
  const c = new CompositeTransport({ telegram: tg });
  const payload = { requestId: "p", custom: { nested: true } };
  await c.notify({ channel: "telegram", payload });
  assert.equal(tg.calls[0], payload, "should pass the same object reference");
});
