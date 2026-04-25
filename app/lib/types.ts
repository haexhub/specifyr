import type { StepId, StepStatus } from "./steps";

export interface ProjectListItem {
  slug: string;
  title: string;
  description?: string;
  projectRoot?: string | null;
  currentStage?: string;
  updatedAt?: string;
  run?: { status?: string } | null;
}

export interface StepState {
  id: StepId;
  status: StepStatus;
  lastSessionId?: string;
  staleSince?: string;
  staleReason?: string;
  updatedAt?: string;
}

export interface SessionMetadata {
  id: string;
  stepId: StepId;
  title: string;
  // "interrupted" = was running when the server died/restarted; user can retry to resume.
  status: "idle" | "running" | "completed" | "failed" | "interrupted";
  claudeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  // Highest seq of any persisted turn event for this session. Clients use it as the
  // initial `since` when subscribing to /turn/stream so they don't replay history.
  lastEventSeq?: number;
  // For status === "running": the seq value just before the in-flight turn began.
  // Clients reconnecting use this as `since` to replay only the active turn's events.
  // Cleared (null) when the turn ends.
  runningSinceSeq?: number | null;
  interruptedAt?: string;
  interruptedReason?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
  toolUse?: {
    name: string;
    input?: Record<string, unknown>;
  };
}

export interface NotificationEvent {
  id: string;
  slug: string;
  type: string;
  level: "info" | "warning" | "error" | "success";
  title: string;
  message?: string;
  stepId?: StepId;
  sessionId?: string;
  taskId?: string;
  createdAt: string;
}
