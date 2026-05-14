import { z } from "zod";
import { loadSessionStore, loadStepStateStore } from "@su/specifyr-stores";
import { resolveProjectOrgId } from "@su/project-store";
import { parseBody, parseParams, stepParams } from "@su/validation";

const sessionCreateSchema = z.object({
  title: z.string().trim().max(256).optional(),
  initialPrompt: z.string().trim().max(8192).optional(),
});

export default defineEventHandler(async (event) => {
  const { slug, stepId } = parseParams(event, stepParams);

  const body = await parseBody(event, sessionCreateSchema);

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);

  const store = await loadSessionStore();
  const created = await store.createSession(orgId, slug, stepId, {
    title: body.title || undefined,
    initialPrompt: body.initialPrompt || undefined,
  });

  // Mark step as in-progress as soon as a session exists (unless already complete)
  const { store: stepStore } = await loadStepStateStore();
  await stepStore.markInProgress(orgId, slug, stepId, created.id);

  return created;
});
