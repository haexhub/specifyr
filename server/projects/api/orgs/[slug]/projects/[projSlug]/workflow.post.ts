import { z } from "zod";
import { assertProjectExists } from "@su/specifyr-stores";
import { listProjectWorkflows } from "@su/workflow-discovery";
import { mutateProjectMeta } from "@su/project-repository";
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

  // Route the read-modify-write through the shared per-(orgId,slug) meta
  // queue so concurrent updates to other meta fields (e.g. repository
  // config, lastPushedAt) cannot clobber each other.
  try {
    await mutateProjectMeta(orgId, slug, (meta) => {
      meta.workflow = workflow;
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing meta is fatal here — assertProjectExists passed but the
      // project has no metadata to update. Fail loud rather than silently
      // creating one.
      throw createError({ statusCode: 500, statusMessage: "Project metadata not found." });
    }
    throw err;
  }

  return { slug, workflow };
});
