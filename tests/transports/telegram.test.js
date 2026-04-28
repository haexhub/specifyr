import test from "node:test";
import assert from "node:assert/strict";

import { TelegramTransport } from "../../src/transports/telegram.js";

function fakeFetchOk() {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 42 } };
      },
    };
  };
  return { fetchFn, calls };
}

function fakeFetchErr(status, body) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: false,
      status,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  };
  return { fetchFn, calls };
}

test("TelegramTransport: ctor rejects missing botToken or chatId", () => {
  assert.throws(() => new TelegramTransport({ chatId: "123" }), /botToken required/);
  assert.throws(() => new TelegramTransport({ botToken: "abc" }), /chatId required/);
});

test("TelegramTransport.notify: POSTs to bot sendMessage endpoint with chat_id + text", async () => {
  const { fetchFn, calls } = fakeFetchOk();
  const t = new TelegramTransport({
    botToken: "bot-secret",
    chatId: "12345",
    fetchFn,
  });

  await t.notify({
    requestId: "req-1",
    slug: "demo",
    agent: "dev",
    capability: "payment:execute_unrestricted",
    requestedAt: "2026-04-28T10:00:00.000Z",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/botbot-secret\/sendMessage$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_id, "12345");
  assert.match(body.text, /dev/);
  assert.match(body.text, /payment:execute_unrestricted/);
  assert.match(body.text, /req-1/);
});

test("TelegramTransport.notify: includes approval URL when approvalUrlBase is configured", async () => {
  const { fetchFn, calls } = fakeFetchOk();
  const t = new TelegramTransport({
    botToken: "bot-secret",
    chatId: "12345",
    approvalUrlBase: "http://localhost:3000",
    fetchFn,
  });
  await t.notify({
    requestId: "req-7",
    slug: "demo",
    agent: "dev",
    capability: "x",
    requestedAt: "2026-04-28T10:00:00.000Z",
  });
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.text, /http:\/\/localhost:3000\/approvals\/req-7/);
});

test("TelegramTransport.notify: skips inline URL when approvalUrlBase missing", async () => {
  const { fetchFn, calls } = fakeFetchOk();
  const t = new TelegramTransport({ botToken: "b", chatId: "c", fetchFn });
  await t.notify({
    requestId: "r",
    slug: "s",
    agent: "a",
    capability: "c",
    requestedAt: "2026-04-28T10:00:00.000Z",
  });
  const body = JSON.parse(calls[0].init.body);
  assert.doesNotMatch(body.text, /http/);
});

test("TelegramTransport.notify: throws on non-2xx response", async () => {
  const { fetchFn } = fakeFetchErr(401, { ok: false, error_code: 401, description: "Unauthorized" });
  const t = new TelegramTransport({ botToken: "b", chatId: "c", fetchFn });
  await assert.rejects(
    () =>
      t.notify({
        requestId: "r",
        slug: "s",
        agent: "a",
        capability: "c",
        requestedAt: "2026-04-28T10:00:00.000Z",
      }),
    /Telegram.*401/,
  );
});
