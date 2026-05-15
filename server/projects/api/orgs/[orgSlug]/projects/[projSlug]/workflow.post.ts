import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { projectArtifactsDir } from "@su/data-dirs";
import { assertProjectExists } from "@su/specifyr-stores";
import { listProjectWorkflows } from "@su/workflow-discovery";
import { parseBody } from "@su/validation";

const workflowBodySchema = z.object({
  workflow: z.string().trim().min(1).max(128),
});

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  await assertProjectExists(orgId, slug);

  const { workflow } = await parseBody(event, workflowBodySchema);

  // Accept only workflows actually available for this project: spec-kit (always) or an installed
  // extension that declares itself as a workflow via its extension.yml tags.
  const available = await listProjectWorkflows(orgId, slug);
  if (!available.some((w) => w.id === workflow)) {
    throw createError({
      statusCode: 400,
      statusMessage: `Workflow '${workflow}' not available in this project. Install an extension that provides it first.`
    });
  }

  const metaPath = path.join(projectArtifactsDir(orgId, slug), "meta.json");
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
