/**
 * Pure helpers for the company-ops MCP dispatch endpoint, kept in src/core/
 * so `node --test` can exercise them without a Nuxt/Nitro harness. The
 * request-bound HTTP handler lives in server/api/mcp/[slug]/dispatch.post.ts.
 *
 * Responsibilities split:
 *   - validateDispatchBody: pre-flight schema check on the incoming body
 *   - buildTaskId: lexicographically-sortable task IDs with collision-safe suffix
 *   - buildDispatchYaml: serialise the task with an injected `source` field
 */

import { randomBytes } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

/**
 * Validate the dispatch request body. Returns either { ok: true } or
 * { ok: false, status, error } so the caller can map to the right HTTP code
 * without throwing — keeps the handler thin.
 *
 * Required shape:
 *   { worker: string, task: { goal: string, ... } }
 *
 * @param {unknown} body
 * @param {string[]} knownRoles  active agent roles for this runtime
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function validateDispatchBody(body, knownRoles) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "request body must be an object" };
  }
  if (typeof body.worker !== "string" || body.worker === "") {
    return { ok: false, status: 400, error: "missing or empty 'worker' field" };
  }
  if (!Array.isArray(knownRoles) || !knownRoles.includes(body.worker)) {
    return {
      ok: false,
      status: 400,
      error: `unknown role '${body.worker}' (known: ${(knownRoles ?? []).join(", ") || "none"})`,
    };
  }
  if (!body.task || typeof body.task !== "object" || Array.isArray(body.task)) {
    return { ok: false, status: 400, error: "missing 'task' object" };
  }
  if (typeof body.task.goal !== "string" || body.task.goal === "") {
    return { ok: false, status: 400, error: "missing or empty 'task.goal'" };
  }
  return { ok: true };
}

/**
 * Generate a lexicographically-sortable, collision-safe task ID.
 * Format: <UTC-ISO-with-:-and-.-replaced-by-->-<8hex>
 *   e.g. "2026-04-27T10-30-45-123Z-a1b2c3d4"
 *
 * Sortable means `ls queue-dev/` shows tasks in the order they were
 * dispatched — invaluable for debugging. The 32-bit random suffix gives
 * 1-in-4-billion collision odds even when same-millisecond dispatches
 * arrive in burst.
 *
 * Both `now` and `randomFn` are injectable for deterministic tests.
 *
 * @param {Date} now
 * @param {(n: number) => Buffer} randomFn  (default: crypto.randomBytes)
 * @returns {string}
 */
export function buildTaskId(now = new Date(), randomFn = randomBytes) {
  const iso = now.toISOString(); // "2026-04-27T10:30:45.123Z"
  const safe = iso.replace(/[:.]/g, "-"); // "2026-04-27T10-30-45-123Z"
  const suffix = randomFn(4).toString("hex"); // 8 chars
  return `${safe}-${suffix}`;
}

/**
 * Build the YAML body of a dispatched task. The `source` field is
 * authoritative — even if the caller supplies their own `source` in
 * `task`, our injected value wins. This is load-bearing for the
 * audit trail (10a's reporting model relies on `source` being
 * trustworthy).
 *
 * @param {object} task   user-supplied task body (must include goal)
 * @param {string} source provenance tag, e.g. "agent:ceo" or "user" or "ingestor:github"
 * @returns {string} YAML text
 */
export function buildDispatchYaml(task, source) {
  // Spread caller's task first, then our source — last write wins, so
  // the injected source overrides any user-supplied value of the same key.
  return stringifyYaml({ ...task, source });
}
