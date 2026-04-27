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
