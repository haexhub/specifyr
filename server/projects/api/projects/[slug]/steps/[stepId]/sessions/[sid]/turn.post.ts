import { z } from "zod";
import {
  loadSessionStore,
  loadStepStateStore,
  loadEventStore,
  loadTurnBroker,
  projectCwd,
  assertProjectExists
} from "@su/specifyr-stores";
import { getProjectWorkflowId } from "@su/workflows";
import {
  SPEC_KIT_WORKFLOW,
  loadInstalledExtensionWorkflow,
  loadBuiltInSpecKitStepInstructions,
  loadStepCommandBody
} from "@su/workflow-discovery";
import { parseBody, parseParams, sessionParams } from "@su/validation";
import { getProjectFromDb, resolveProjectOrgId } from "@su/project-store";
import { createSpeckitRunnerFactory } from "@su/speckit-agent-runner";

const turnSchema = z.object({
  content: z.string().trim().min(1).max(32_000),
});

/**
 * Kicks off a chat turn. The turn runs in the background under the TurnBroker —
 * this handler returns immediately with `startSeq` so the caller knows what
 * `since=` value to use when subscribing to GET /turn/stream.
 *
 * Disconnecting from this POST does NOT cancel the turn: the runner's lifecycle
 * is owned by the broker, not by any single HTTP connection.
 */
export default defineEventHandler(async (event) => {
  const { slug, stepId, sid } = parseParams(event, sessionParams);
  const { content } = await parseBody(event, turnSchema);

  // TODO(phase-3): drop DB lookup once project-access middleware sets event.context.orgId.
  const orgId = await resolveProjectOrgId(slug);
  await assertProjectExists(orgId, slug);

  const sessionStore = await loadSessionStore();
  const session = await sessionStore.getSessionMeta(orgId, slug, stepId, sid);
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }

  const broker = await loadTurnBroker();
  if (broker.isRunning(orgId, slug, stepId, sid)) {
    throw createError({
      statusCode: 409,
      statusMessage: "A turn is already running for this session."
    });
  }

  // Prepend the step command context until the agent has produced a successful
  // assistant reply. Using messageCount would lock out the inject after failed
  // turns: appendMessage runs before kickoff "so it survives any failure mode",
  // so failed user turns still bump the counter — but the agent never saw the
  // workflow instructions, and on the next attempt it would answer the bare
  // prompt with no idea which step it's in.
  const priorMessages = await sessionStore.listMessages(orgId, slug, stepId, sid);
  const hasSuccessfulAssistantReply = priorMessages.some(
    (m: { role: string; metadata?: { failed?: boolean } }) =>
      m.role === "assistant" && !m.metadata?.failed,
  );
  let promptForAgent = content;
  if (!hasSuccessfulAssistantReply) {
    const workflowId = await getProjectWorkflowId(orgId, slug);
    const workflow =
      workflowId === "spec-kit"
        ? SPEC_KIT_WORKFLOW
        : (await loadInstalledExtensionWorkflow(orgId, slug, workflowId)) ?? SPEC_KIT_WORKFLOW;
    const stepDef = workflow.steps.find((s) => s.id === stepId);
    if (stepDef?.command) {
      const stepIndex = workflow.steps.findIndex((s) => s.id === stepId);
      const total = workflow.steps.length;
      const nextStep = stepIndex + 1 < total ? workflow.steps[stepIndex + 1] : null;
      const workflowCtx = [
        `SPECIFYR WORKFLOW CONTEXT:`,
        `You are in step ${stepIndex + 1} of ${total} ("${stepDef.label}") of the "${workflow.label}" workflow.`,
        nextStep ? `The next step is "${nextStep.label}".` : `This is the final step.`,
        `Focus exclusively on this step. Do not suggest actions from later steps or start the company runtime.`,
        `If this step's artifacts already exist, confirm what is done and ask what to adjust or finalize for this step.`
      ].join(" ");
      // Inject the full command-file body when an extension provides one.
      const commandBody =
        workflowId === "spec-kit"
          ? loadBuiltInSpecKitStepInstructions(stepId)
          : await loadStepCommandBody(orgId, slug, workflowId, stepId);
      const commandLabel = `Workflow command: ${stepDef.command}`;
      if (commandBody) {
        promptForAgent = `${commandLabel}\n\n${commandBody}\n\n---\n\n${workflowCtx}\n\n${content}`;
      } else {
        promptForAgent = `${commandLabel}\n\n${workflowCtx}\n\n${content}`;
      }
    }
  }

  // Resolve the runner factory FIRST — it can throw 400/401 when no
  // agent profile is configured, and we don't want to mutate session
  // state (appendMessage / markInProgress / session_started event) for
  // a turn we won't actually start.
  const project = await getProjectFromDb(slug);
  const runnerFactory = await createSpeckitRunnerFactory({
    userId: event.context.userId,
    ownerOrgId: project?.ownerOrgId ?? null,
    runtimeConfig: useRuntimeConfig(),
  });

  // Persist the user message before kickoff so it survives any failure mode.
  const userMessage = await sessionStore.appendMessage(orgId, slug, stepId, sid, {
    role: "user",
    content
  });

  const { store: stepStore } = await loadStepStateStore();
  await stepStore.markInProgress(orgId, slug, stepId, sid);

  const eventStore = await loadEventStore(orgId, slug);
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
    orgId,
    slug,
    stepId,
    sid,
    prompt: promptForAgent,
    cwd: projectCwd(orgId, slug),
    claudeSessionId: session.claudeSessionId ?? null,
    runnerFactory,
  });

  setResponseStatus(event, 202);
  return {
    accepted: true,
    startSeq,
    userMessage
  };
});
