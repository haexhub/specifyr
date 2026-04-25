export class ModelProvider {
  constructor(name) {
    this.name = name;
  }

  async generate(_input, _options) {
    throw new Error("ModelProvider.generate must be implemented.");
  }
}

export class LocalTemplateProvider extends ModelProvider {
  constructor() {
    super("local-template");
  }

  async generate(input, options = {}) {
    const stage = options.stage ?? "generic";
    if (stage === "spec_refine") {
      return {
        summary: `Refined spec for ${input.title}.`,
        notes: [
          "Goals clarified against observable outcomes.",
          "Constraints normalized into explicit acceptance criteria.",
          "Execution stays gated through human approvals."
        ]
      };
    }
    if (stage === "plan_generate") {
      const criteria = input.acceptanceCriteria.length > 0 ? input.acceptanceCriteria : ["Deliver an initial working path."];
      return {
        summary: `Implement ${input.title} through explicit artifacts and controlled execution stages.`,
        phases: criteria.map((criterion, index) => ({
          name: `Phase ${index + 1}`,
          objective: criterion
        })),
        risks: [
          "Task decomposition may be too coarse for safe execution.",
          "External provider integration can drift from the local adapter contract."
        ],
        verification: [
          "Validate every workflow transition with automated tests.",
          "Expose all artifacts and events in the local UI."
        ]
      };
    }
    if (stage === "tasks_generate") {
      return {
        summary: `Convert the plan for ${input.title} into executable work items.`,
        tasks: input.phases.map((phase, index) => ({
          id: `task-${index + 1}`,
          title: phase.name,
          goal: phase.objective,
          inputs: ["spec.md", "plan.md"],
          scope: [".specops", "src", "public", "tests"],
          allowedCapabilities: ["read_repo", "write_repo", "run_checks"],
          successCriteria: [`Completed objective: ${phase.objective}`],
          expectedOutputs: [`result-${index + 1}.md`],
          dependencies: index === 0 ? [] : [`task-${index}`]
        }))
      };
    }
    if (stage === "run_review") {
      return {
        summary: `Run review for ${input.slug}: ${input.completed}/${input.total} tasks completed.`,
        recommendation: input.failed > 0 ? "Investigate failed tasks before continuing." : "Run is ready for completion."
      };
    }
    return { summary: `Generated output for stage ${stage}.` };
  }
}

export class OpenAICompatibleProvider extends ModelProvider {
  constructor(config = {}) {
    super("openai-compatible");
    this.config = config;
  }

  async generate(input, options = {}) {
    return {
      summary: "OpenAI-compatible provider is configured as a contract adapter stub.",
      input,
      options,
      config: {
        baseUrl: this.config.baseUrl ?? null,
        model: this.config.model ?? null
      }
    };
  }
}
