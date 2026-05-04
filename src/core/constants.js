export const SPECIFYR_DIR = ".specifyr";
export const SPECIFY_DIR = ".specify";

export const RUN_STATUSES = [
  "draft",
  "refined",
  "planned",
  "approved_for_execution",
  "running",
  "blocked",
  "completed",
  "failed"
];

export const APPROVAL_STAGES = ["spec", "plan", "task_batch"];

export const WORKFLOW_STAGES = {
  SPEC_REFINE: "spec_refine",
  PLAN_GENERATE: "plan_generate",
  TASKS_GENERATE: "tasks_generate",
  RUN_EXECUTION: "run_execution",
  RUN_REVIEW: "run_review"
};

export const DEFAULT_PORT = 4312;

export const DEFAULT_CONFIG = {
  integrations: {
    specKitSync: true,
    fabric: {
      enabled: false,
      command: "fabric"
    },
    hermes: {
      enabled: false,
      command: "hermes"
    }
  },
  providers: {
    default: "local",
    openaiCompatible: {
      baseUrl: "",
      model: ""
    }
  },
  patterns: {
    spec_refine: "refine-spec",
    plan_generate: "decompose-plan",
    tasks_generate: "critique-task",
    run_execution: "summarize",
    run_review: "analyze_answers"
  }
};
