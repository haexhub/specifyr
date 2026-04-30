/**
 * POST /api/mcp/<slug>/dispatch
 *
 * CEO-side delegation endpoint. The CEO container calls this to drop a
 * sub-task for a worker role. We validate the request, write a YAML
 * file into the worker's queue dir, and return the path. The runtime's
 * per-role QueuePoller picks it up via chokidar — no in-process call
 * into the runtime needed.
 *
 * Request body:
 *   {
 *     worker: string                  worker role to dispatch to (e.g. "dev")
 *     task: {
 *       goal: string                  required; the worker's instruction
 *       title?, inputs?, scope?,
 *       expected_outputs?, ...        all optional, passed through to the YAML
 *     }
 *   }
 *
 * Response (200):
 *   { dispatched: true, role: string, path: string, taskId: string }
 *
 * Errors:
 *   400 — body shape invalid, unknown worker role, missing goal
 *   401 — bearer auth failure (via requireRuntimeAuth)
 *   404 — no active runtime for this slug (via requireRuntimeAuth)
 *
 * Source field: every dispatched ticket gets `source: "agent:<ceoRole>"`
 * injected (authoritative — caller cannot override). This is load-bearing
 * for the audit trail planned in Inkrement 10a.
 *
 * Idempotency: not implemented in v1. Retries by the caller produce
 * duplicate tasks. A future iteration can add `task_id` body-field-based
 * deduplication if it becomes a real problem.
 */

import path from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { requireRuntimeAuth } from "@su/mcp-auth";

interface DispatchBody {
  worker?: string;
  task?: {
    goal?: string;
    [key: string]: unknown;
  };
}

interface McpDispatchModule {
  validateDispatchBody: (
    body: unknown,
    knownRoles: string[],
  ) => { ok: true } | { ok: false; status: number; error: string };
  buildTaskId: () => string;
  buildDispatchYaml: (task: object, source: string) => string;
}

let _mcpDispatchMod: McpDispatchModule | null = null;
async function loadMcpDispatch(): Promise<McpDispatchModule> {
  if (_mcpDispatchMod) return _mcpDispatchMod;
  const url = pathToFileURL(path.join(process.cwd(), "src/core/mcp-dispatch.js")).href;
  _mcpDispatchMod = (await import(url)) as McpDispatchModule;
  return _mcpDispatchMod;
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  const runtime = await requireRuntimeAuth(event, slug);
  const body = await readBody<DispatchBody>(event);

  const { validateDispatchBody, buildTaskId, buildDispatchYaml } = await loadMcpDispatch();

  const knownRoles = runtime.listAgents().map((a) => a.role);
  const validation = validateDispatchBody(body, knownRoles);
  if (!validation.ok) {
    throw createError({ statusCode: validation.status, statusMessage: validation.error });
  }

  // After validation we can trust these are present and well-typed.
  const worker = body!.worker as string;
  const task = body!.task as object;

  const queueDir = runtime.getRoleQueueDir(worker);
  if (!queueDir) {
    // Defensive: validation already confirmed `worker` is in listAgents(),
    // and start() ensures every agent has a queue dir. If we still land
    // here, it's a runtime invariant break, not a user error.
    throw createError({
      statusCode: 500,
      statusMessage: `Internal: no queue dir for known role '${worker}'`,
    });
  }

  const taskId = buildTaskId();
  const filename = `${taskId}.yaml`;
  const filepath = path.join(queueDir, filename);

  // Source provenance: in v1 only the CEO dispatches sub-tasks via this
  // endpoint (single-authority pattern; worker-to-worker is out of scope).
  // We tag every dispatched ticket with `agent:<ceoRole>` so the audit
  // trail can distinguish CEO-delegated work from user-injected tickets
  // and (later) ingestor-injected ones.
  const source = `agent:${runtime.ceoRole}`;
  const yamlText = buildDispatchYaml(task, source);

  await writeFile(filepath, yamlText, "utf8");

  return {
    dispatched: true,
    role: worker,
    path: filepath,
    taskId,
  };
});
