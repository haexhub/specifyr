import {
  loadSessionStore,
  loadStepStateStore,
  loadEventStore,
  loadTurnBroker,
  projectCwd,
  assertProjectExists
} from "../../../../../../../utils/specops-stores";
import { getProjectStepIds, getProjectWorkflowId } from "../../../../../../../utils/workflows";
import { SPEC_KIT_WORKFLOW, loadInstalledExtensionWorkflow } from "../../../../../../../utils/workflow-discovery";

/**
 * Kicks off a chat turn. The turn runs in the background under the TurnBroker —
 * this handler returns immediately with `startSeq` so the caller knows what
 * `since=` value to use when subscribing to GET /turn/stream.
 *
 * Disconnecting from this POST does NOT cancel the turn: the runner's lifecycle
 * is owned by the broker, not by any single HTTP connection.
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  const stepId = getRouterParam(event, "stepId");
  const sid = getRouterParam(event, "sid");
  if (!slug || !stepId || !sid) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug/stepId/sid" });
  }

  const body = await readBody<{ content?: string }>(event);
  const content = body?.content?.trim();
  if (!content) {
    throw createError({ statusCode: 400, statusMessage: "Message content is required." });
  }

  await assertProjectExists(slug);

  const sessionStore = await loadSessionStore();
  const session = await sessionStore.getSessionMeta(slug, stepId, sid);
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }

  const broker = await loadTurnBroker();
  if (broker.isRunning(slug, stepId, sid)) {
    throw createError({
      statusCode: 409,
      statusMessage: "A turn is already running for this session."
    });
  }

  // Prepend the step's slash-command on the very first turn so Claude resolves the right
  // skill. Same as before — the persisted user message stays as the user typed it; only
  // the prompt sent to Claude carries the prefix.
  const isFirstUserTurn = (session.messageCount ?? 0) === 0;
  let promptForClaude = content;
  if (isFirstUserTurn) {
    const workflowId = await getProjectWorkflowId(slug);
    const workflow =
      workflowId === "spec-kit"
        ? SPEC_KIT_WORKFLOW
        : (await loadInstalledExtensionWorkflow(slug, workflowId)) ?? SPEC_KIT_WORKFLOW;
    const stepDef = workflow.steps.find((s) => s.id === stepId);
    if (stepDef?.command) {
      const stepIndex = workflow.steps.findIndex((s) => s.id === stepId);
      const total = workflow.steps.length;
      const nextStep = stepIndex + 1 < total ? workflow.steps[stepIndex + 1] : null;
      const workflowCtx = [
        `SPECOPS WORKFLOW CONTEXT:`,
        `You are in step ${stepIndex + 1} of ${total} ("${stepDef.label}") of the "${workflow.label}" workflow.`,
        nextStep
          ? `The next step is "${nextStep.label}" — it will unlock automatically once this step's artifacts are present.`
          : `This is the final step.`,
        `Focus exclusively on this step. Do not suggest actions from later steps or start the company runtime.`,
        `If this step's artifacts already exist, confirm what is done and ask what to adjust or finalize for this step.`
      ].join(" ");
      promptForClaude = `${stepDef.command}\n\n${workflowCtx}\n\n${content}`;
    }
  }

  // Persist the user message before kickoff so it survives any failure mode.
  const userMessage = await sessionStore.appendMessage(slug, stepId, sid, {
    role: "user",
    content
  });

  const { store: stepStore } = await loadStepStateStore();
  await stepStore.markInProgress(slug, stepId, sid);

  const eventStore = await loadEventStore(slug);
  await eventStore.append({
    type: "session_started",
    level: "info",
    slug,
    stepId,
    sessionId: sid,
    createdAt: new Date().toISOString(),
    title: "Chat-Turn gestartet"
  });

  // Kick off the broker. This returns once the runner is spawned — the actual run
  // continues in the background. `startSeq` is the seq value BEFORE this turn began,
  // so the client can stream every event from this turn (and only this turn).
  const { startSeq } = await broker.startTurn({
    slug,
    stepId,
    sid,
    prompt: promptForClaude,
    cwd: projectCwd(slug),
    claudeSessionId: session.claudeSessionId ?? null
  });

  setResponseStatus(event, 202);
  return {
    accepted: true,
    startSeq,
    userMessage
  };
});
