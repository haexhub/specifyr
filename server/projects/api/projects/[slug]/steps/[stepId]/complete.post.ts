import { z } from "zod";
import { loadStepStateStore, loadEventStore } from "@su/specifyr-stores";
import { triggerAutoPush } from "@su/repository-autosync";
import { parseBody, parseParams, stepParams } from "@su/validation";

const completeSchema = z.object({
  sessionId: z.string().trim().min(1).max(128).optional(),
});

export default defineEventHandler(async (event) => {
  const { slug, stepId } = parseParams(event, stepParams);
  const body = await parseBody(event, completeSchema);

  const { store } = await loadStepStateStore();
  const events = await loadEventStore(slug);

  const updated = await store.markComplete(slug, stepId, body.sessionId ?? null);

  await events.append({
    type: "step_marked_complete",
    level: "success",
    slug,
    stepId,
    sessionId: body.sessionId,
    createdAt: new Date().toISOString(),
    title: `Step '${stepId}' als erledigt markiert`
  });

  triggerAutoPush(slug);

  return updated;
});
