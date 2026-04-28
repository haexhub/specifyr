import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { Supervisor } from "../src/core/supervisor.js";

/**
 * Stub runtime that satisfies the Supervisor's dependencies without spinning
 * up a real CompanyRuntime. The supervisor only reads:
 *   - runtime.on('dispatch-started', ...)
 *   - runtime.on('dispatched', ...)
 *   - runtime.on('dispatch-error', ...)
 *   - runtime.getAgent(role)            for SLA lookup
 *   - runtime.ceoRole
 *   - runtime.slug
 *   - runtime.getRoleQueueDir(role)     for intervention ticket placement
 */
function stubRuntime({ agents = {}, queueDirs = {}, slug = "demo", ceoRole = "ceo" } = {}) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    slug,
    ceoRole,
    getAgent(role) { return agents[role] ?? null; },
    getRoleQueueDir(role) { return queueDirs[role] ?? null; },
  });
}

function stubEventLog() {
  const captured = [];
  return {
    captured,
    async append(evt) {
      captured.push(evt);
      return { id: "x", at: "y", file: "z" };
    },
  };
}

test("Supervisor: construct + start/stop are idempotent and don't keep event-loop alive", () => {
  const runtime = stubRuntime();
  const log = stubEventLog();
  const sup = new Supervisor({ runtime, eventLog: log });
  sup.start();
  sup.stop();
  // No assertions — test passes if it doesn't hang. setInterval must be cleared.
});

test("Supervisor: ctor rejects when runtime or eventLog is missing", () => {
  assert.throws(() => new Supervisor({ eventLog: stubEventLog() }), /runtime required/);
  assert.throws(() => new Supervisor({ runtime: stubRuntime() }), /eventLog required/);
});

// ---------------------------------------------------------------------------
// Tracking pending dispatches via runtime events
// ---------------------------------------------------------------------------

test("Supervisor: dispatch-started → pending; dispatched → removed", () => {
  const runtime = stubRuntime();
  const sup = new Supervisor({ runtime, eventLog: stubEventLog(), intervalMs: 0 });
  sup.start();

  runtime.emit("dispatch-started", { path: "/q/a.yaml", role: "dev", workItem: { title: "a" } });
  assert.equal(sup._pending.size, 1);

  runtime.emit("dispatched", { path: "/q/a.yaml", role: "dev", result: { status: "completed" } });
  assert.equal(sup._pending.size, 0);

  sup.stop();
});

test("Supervisor: dispatch-error also clears pending", () => {
  const runtime = stubRuntime();
  const sup = new Supervisor({ runtime, eventLog: stubEventLog(), intervalMs: 0 });
  sup.start();

  runtime.emit("dispatch-started", { path: "/q/a.yaml", role: "dev", workItem: { title: "a" } });
  runtime.emit("dispatch-error", { path: "/q/a.yaml", role: "dev", error: new Error("boom") });
  assert.equal(sup._pending.size, 0);

  sup.stop();
});

test("Supervisor: stop() unsubscribes — late events are ignored", () => {
  const runtime = stubRuntime();
  const sup = new Supervisor({ runtime, eventLog: stubEventLog(), intervalMs: 0 });
  sup.start();
  sup.stop();
  runtime.emit("dispatch-started", { path: "/q/late.yaml", role: "dev", workItem: { title: "late" } });
  assert.equal(sup._pending.size, 0);
});

// ---------------------------------------------------------------------------
// Stuck detection + escalation
// ---------------------------------------------------------------------------

test("Supervisor.tick: no alert when all pending dispatches are within SLA", async () => {
  let now = 1_000_000;
  const runtime = stubRuntime();
  const log = stubEventLog();
  const sup = new Supervisor({
    runtime,
    eventLog: log,
    intervalMs: 0,
    defaultSlaMs: 60_000,
    clock: () => now,
  });
  sup.start();

  runtime.emit("dispatch-started", { path: "/q/fresh.yaml", role: "dev", workItem: { title: "fresh" } });
  now += 30_000; // half the SLA — still healthy
  await sup.tick();
  assert.equal(log.captured.length, 0);

  sup.stop();
});

test("Supervisor.tick: emits agent-stuck event after SLA expired", async () => {
  let now = 1_000_000;
  const runtime = stubRuntime();
  const log = stubEventLog();
  const sup = new Supervisor({
    runtime,
    eventLog: log,
    intervalMs: 0,
    defaultSlaMs: 60_000,
    clock: () => now,
  });
  sup.start();

  runtime.emit("dispatch-started", { path: "/q/slow.yaml", role: "dev", workItem: { title: "slow" } });
  now += 120_000; // 2× SLA → stuck
  await sup.tick();

  const stuck = log.captured.find((e) => e.type === "agent-stuck");
  assert.ok(stuck, "expected agent-stuck event");
  assert.equal(stuck.role, "dev");
  assert.equal(stuck.task_path, "/q/slow.yaml");
  assert.equal(stuck.stuck_for_ms, 120_000);

  sup.stop();
});

test("Supervisor.tick: does NOT re-alert on subsequent ticks for the same stuck dispatch", async () => {
  let now = 1_000_000;
  const runtime = stubRuntime();
  const log = stubEventLog();
  const sup = new Supervisor({
    runtime,
    eventLog: log,
    intervalMs: 0,
    defaultSlaMs: 60_000,
    clock: () => now,
  });
  sup.start();

  runtime.emit("dispatch-started", { path: "/q/zombie.yaml", role: "dev", workItem: { title: "zombie" } });
  now += 120_000;
  await sup.tick();
  await sup.tick();
  await sup.tick();

  const stuckEvents = log.captured.filter((e) => e.type === "agent-stuck");
  assert.equal(stuckEvents.length, 1, "expected exactly one alert per stuck dispatch");

  sup.stop();
});

test("Supervisor.tick: per-agent sla_seconds overrides default", async () => {
  let now = 1_000_000;
  const runtime = stubRuntime({ agents: { dev: { role: "dev", sla_seconds: 10 } } });
  const log = stubEventLog();
  const sup = new Supervisor({
    runtime,
    eventLog: log,
    intervalMs: 0,
    defaultSlaMs: 3_600_000, // 1h default — would never alert
    clock: () => now,
  });
  sup.start();

  runtime.emit("dispatch-started", { path: "/q/fast.yaml", role: "dev", workItem: { title: "fast" } });
  now += 11_000; // 11s, exceeds dev's 10s SLA
  await sup.tick();

  assert.ok(log.captured.find((e) => e.type === "agent-stuck"), "per-agent SLA must be honored");
  sup.stop();
});

test("Supervisor.tick: writes intervention ticket to queue-ceo", async () => {
  let now = 1_000_000;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sup-"));
  const queueCeo = path.join(tmp, "queue-ceo");
  await fs.mkdir(queueCeo, { recursive: true });

  try {
    const runtime = stubRuntime({ queueDirs: { ceo: queueCeo } });
    const log = stubEventLog();
    const sup = new Supervisor({
      runtime,
      eventLog: log,
      intervalMs: 0,
      defaultSlaMs: 60_000,
      clock: () => now,
    });
    sup.start();

    runtime.emit("dispatch-started", { path: "/q/dead.yaml", role: "dev", workItem: { title: "dead" } });
    now += 120_000;
    await sup.tick();

    const files = (await fs.readdir(queueCeo)).filter((f) => f.endsWith(".yaml"));
    assert.equal(files.length, 1, "expected exactly one intervention ticket");

    const { parse: parseYaml } = await import("yaml");
    const body = parseYaml(await fs.readFile(path.join(queueCeo, files[0]), "utf8"));
    assert.equal(body.source, "supervisor");
    assert.equal(body.intervention.kind, "agent-stuck");
    assert.equal(body.intervention.stuck_role, "dev");
    assert.equal(body.intervention.stuck_task_path, "/q/dead.yaml");
    assert.equal(body.intervention.stuck_for_ms, 120_000);

    sup.stop();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Supervisor.tick: gracefully no-ops when CEO queue dir is unavailable", async () => {
  let now = 1_000_000;
  const runtime = stubRuntime({ queueDirs: {} }); // no ceo queue
  const log = stubEventLog();
  const sup = new Supervisor({
    runtime,
    eventLog: log,
    intervalMs: 0,
    defaultSlaMs: 60_000,
    clock: () => now,
  });
  sup.start();

  runtime.emit("dispatch-started", { path: "/q/orphan.yaml", role: "dev", workItem: { title: "x" } });
  now += 120_000;
  await sup.tick();

  // agent-stuck event must still be logged for audit, even without queue
  assert.ok(log.captured.find((e) => e.type === "agent-stuck"));

  sup.stop();
});
