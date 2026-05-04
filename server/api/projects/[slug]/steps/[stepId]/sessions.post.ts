import { loadSessionStore, loadStepStateStore } from "@su/specifyr-stores";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  if (!slug || !stepId) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId" });
  }

  const body = await readBody<{ title?: string; initialPrompt?: string }>(event);

  const store = await loadSessionStore();
  const created = await store.createSession(slug, stepId, {
    title: body?.title?.trim() || undefined,
    initialPrompt: body?.initialPrompt?.trim() || undefined
  });

  // Mark step as in-progress as soon as a session exists (unless already complete)
  const { store: stepStore } = await loadStepStateStore();
  await stepStore.markInProgress(slug, stepId, created.id);

  return created;
});
