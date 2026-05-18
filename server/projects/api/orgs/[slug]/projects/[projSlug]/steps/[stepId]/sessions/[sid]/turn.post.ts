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
import { createSpeckitRunnerFactory } from "@su/speckit-agent-runner";

const turnSchema = z.object({
  content: z.string().trim().min(1).max(32_000),
});

// On idle/restart/crash recovery we replay this many trailing messages. Set
// generously: users may return after hours or days and need the agent to feel
// like it remembers the whole conversation. Pathologically long chats are
// bounded so the recovery prompt stays under Claude's context limit.
const HISTORY_CONTEXT_LIMIT = 100;

/**
 * Build the workflow-context prefix that goes in front of the user's content on
 * turn 1, AND on recovery turns when the keep-alive session was lost. Returns
 * null when the workflow has no command file for this step.
 */
async function buildWorkflowPrefix(
  orgId: string,
  slug: string,
  stepId: string,
): Promise<string | null> {
  const workflowId = await getProjectWorkflowId(orgId, slug);
  // Two layers of fallback when resolving the workflow for this step:
  //   1. The chosen workflow id may point at an extension that's not on-disk
  //      anywhere (per-project AND globally). resolveExtensionDir inside
  //      loadInstalledExtensionWorkflow handles the "globally registered but
  //      not project-installed" case; if BOTH miss, we fall back to spec-kit.
  //   2. Even when the extension workflow IS resolved, the step the user is on
  //      may belong to spec-kit (e.g. project workflow is "speckit-company"
  //      but the user navigated to `/steps/constitution`, a spec-kit step
  //      with no equivalent in speckit-company). In that case we also fall
  //      back to spec-kit so the agent gets the built-in instructions
  //      instead of an empty prompt prefix.
  const extensionWorkflow =
    workflowId !== "spec-kit"
      ? await loadInstalledExtensionWorkflow(orgId, slug, workflowId)
      : null;
  const extensionHasStep =
    extensionWorkflow?.steps.some((s) => s.id === stepId) === true;
  const workflow = extensionHasStep ? extensionWorkflow! : SPEC_KIT_WORKFLOW;
  const usingBuiltInSpecKit = workflow === SPEC_KIT_WORKFLOW;
  const stepDef = workflow.steps.find((s) => s.id === stepId);
  if (!stepDef?.command) return null;
  const stepIndex = workflow.steps.findIndex((s) => s.id === stepId);
  const total = workflow.steps.length;
  const nextStep = stepIndex + 1 < total ? workflow.steps[stepIndex + 1] : null;
  const workflowCtx = [
    `SPECIFYR WORKFLOW CONTEXT:`,
    `You are in step ${stepIndex + 1} of ${total} ("${stepDef.label}") of the "${workflow.label}" workflow.`,
    nextStep ? `The next step is "${nextStep.label}".` : `This is the final step.`,
    `Focus exclusively on this step. Do not suggest actions from later steps or start the company runtime.`,
    `If this step's artifacts already exist, confirm what is done and ask what to adjust or finalize for this step.`,
  ].join(" ");
  const commandBody = usingBuiltInSpecKit
    ? loadBuiltInSpecKitStepInstructions(stepId)
    : await loadStepCommandBody(orgId, slug, workflowId, stepId);
  const commandLabel = `Workflow command: ${stepDef.command}`;
  return commandBody
    ? `${commandLabel}\n\n${commandBody}\n\n---\n\n${workflowCtx}`
    : `${commandLabel}\n\n${workflowCtx}`;
}

/**
 * Kicks off a chat turn. The turn runs in the background under the TurnBroker —
 * this handler returns immediately with `startSeq` so the caller knows what
 * `since=` value to use when subscribing to GET /turn/stream.
 *
 * Disconnecting from this POST does NOT cancel the turn: the runner's lifecycle
 * is owned by the broker, not by any single HTTP connection.
 */
export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId!;
  const slug = event.context.projectSlug!;
  const { stepId, sid } = parseParams(event, sessionParams);
  const { content } = await parseBody(event, turnSchema);

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
  // The broker holds a long-lived ACP child + session per chat (keep-alive),
  // so follow-up turns can rely on the agent's in-process conversation memory.
  // If that cache is missing (server restart, idle timeout, child crashed), we
  // fall back to replaying the recent history as a prefix on this turn's prompt.
  const hasLiveAgentSession = broker.hasLiveSession(orgId, slug, stepId, sid);
  let promptForAgent = content;
  if (!hasSuccessfulAssistantReply) {
    const prefix = await buildWorkflowPrefix(orgId, slug, stepId);
    if (prefix) promptForAgent = `${prefix}\n\n${content}`;
  } else if (!hasLiveAgentSession && priorMessages.length > 0) {
    // No live keep-alive session — the agent process has either never run for
    // this chat (cache lost on restart), been closed by idle timeout, or its
    // child crashed. Rebuild the FULL initial context: re-inject the workflow
    // command body + ctx (so the agent knows what step it's in and what
    // instructions apply) and replay the prior conversation. Costs more init
    // tokens but lets users resume after hours/days without the agent having
    // "forgotten" the step.
    const tail = priorMessages.slice(-HISTORY_CONTEXT_LIMIT) as Array<{
      role: string;
      content: string;
    }>;
    const history = tail
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    const truncatedNote =
      priorMessages.length > tail.length
        ? `\n\n[…${priorMessages.length - tail.length} ältere Nachrichten weggelassen…]`
        : "";
    const prefix = await buildWorkflowPrefix(orgId, slug, stepId);
    const parts: string[] = [];
    if (prefix) parts.push(prefix);
    parts.push(`[Bisheriger Gesprächsverlauf]${truncatedNote}\n\n${history}`);
    parts.push(content);
    promptForAgent = parts.join("\n\n---\n\n");
  }

  // Resolve the runner factory FIRST — it can throw 400/401 when no
  // agent profile is configured, and we don't want to mutate session
  // state (appendMessage / markInProgress / session_started event) for
  // a turn we won't actually start.
  const runnerFactory = await createSpeckitRunnerFactory({
    userId: event.context.userId,
    ownerOrgId: orgId,
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
