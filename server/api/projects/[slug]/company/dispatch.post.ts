/**
 * POST /api/projects/<slug>/company/dispatch
 *
 * User-initiated task dispatch to the CEO queue. Unlike the MCP dispatch
 * endpoint (/api/mcp/<slug>/dispatch), this does NOT require the runtime
 * bearer token — it is called from the browser by the project owner.
 *
 * Body: { goal: string, title?: string }
 * Response: { dispatched: true, role: "ceo", path: string, taskId: string }
 */

import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getActiveCompany } from "@su/company-manager";
import { parseBody, parseParams, projectSlugParam } from "@su/validation";

const dispatchSchema = z.object({
  goal: z.string().trim().min(1).max(8192),
  title: z.string().trim().min(1).max(256).optional(),
});

interface McpDispatchModule {
  buildTaskId: () => string;
  buildDispatchYaml: (task: object, source: string) => string;
}

let _mod: McpDispatchModule | null = null;
async function loadMcpDispatch(): Promise<McpDispatchModule> {
  if (_mod) return _mod;
  const url = pathToFileURL(path.join(process.cwd(), "src/core/mcp-dispatch.js")).href;
  _mod = (await import(url)) as McpDispatchModule;
  return _mod;
}

export default defineEventHandler(async (event) => {
  const { slug } = parseParams(event, projectSlugParam);

  const runtime = getActiveCompany(slug);
  if (!runtime) {
    throw createError({ statusCode: 409, statusMessage: `No active company runtime for '${slug}'` });
  }

  const body = await parseBody(event, dispatchSchema);

  const ceoRole = (runtime as any).ceoRole ?? "ceo";
  const queueDir = runtime.getRoleQueueDir(ceoRole);
  if (!queueDir) {
    throw createError({ statusCode: 500, statusMessage: `No queue dir for CEO role '${ceoRole}'` });
  }

  const { buildTaskId, buildDispatchYaml } = await loadMcpDispatch();

  const task: Record<string, unknown> = { goal: body.goal };
  if (body.title) task.title = body.title;

  await mkdir(queueDir, { recursive: true });
  const taskId = buildTaskId();
  const filepath = path.join(queueDir, `${taskId}.yaml`);
  await writeFile(filepath, buildDispatchYaml(task, "user"), "utf8");

  return { dispatched: true, role: ceoRole, path: filepath, taskId };
});
