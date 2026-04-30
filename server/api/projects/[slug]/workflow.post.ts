import path from "node:path";
import fs from "node:fs/promises";
import { dataDir } from "#su/data-dirs";
import { assertProjectExists } from "#su/specops-stores";
import { listProjectWorkflows } from "#su/workflow-discovery";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }
  await assertProjectExists(slug);

  const body = await readBody<{ workflow?: string }>(event);
  const workflow = body?.workflow;
  if (!workflow || typeof workflow !== "string") {
    throw createError({ statusCode: 400, statusMessage: "Body must contain a 'workflow' id." });
  }

  // Accept only workflows actually available for this project: spec-kit (always) or an installed
  // extension that declares itself as a workflow via its extension.yml tags.
  const available = await listProjectWorkflows(slug);
  if (!available.some((w) => w.id === workflow)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Workflow '${workflow}' not available in this project. Install an extension that provides it first.`
    });
  }

  const metaPath = path.join(dataDir(), ".specops", slug, "meta.json");
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    // Missing meta is fatal here — the project exists on disk (assertProjectExists passed) but
    // without meta we have no record to update. Fail loud rather than silently creating one.
    throw createError({ statusCode: 500, statusMessage: "Project metadata not found." });
  }

  meta.workflow = workflow;
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  return { slug, workflow };
});
