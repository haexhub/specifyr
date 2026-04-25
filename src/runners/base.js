export class AgentRunner {
  constructor(name) {
    this.name = name;
  }

  async execute(_workItem, _runtimeContext) {
    throw new Error("AgentRunner.execute must be implemented.");
  }
}

export class HermesAgentRunner extends AgentRunner {
  constructor() {
    super("hermes-agent");
  }

  async execute(workItem, runtimeContext) {
    if (!Array.isArray(workItem.scope) || workItem.scope.length === 0) {
      return {
        status: "failed",
        summary: "Work item has no explicit scope and was blocked for safety.",
        outputs: [],
        reviewStatus: "rejected",
        nextEvent: "add_scope"
      };
    }

    return {
      status: "completed",
      summary: `Executed ${workItem.title} with ${this.name} using ${runtimeContext.pattern.name}.`,
      outputs: workItem.expectedOutputs,
      reviewStatus: "accepted",
      nextEvent: "review_result",
      metadata: {
        runner: this.name,
        provider: runtimeContext.provider.name
      }
    };
  }
}
