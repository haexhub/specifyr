import { HermesAgentRunner } from "./base.js";
import { runCommand } from "../utils/process.js";

function buildHermesPrompt(workItem, runtimeContext) {
  return [
    `You are executing a single scoped work item for slug '${runtimeContext.slug}'.`,
    `Pattern: ${runtimeContext.pattern.name}`,
    `Goal: ${workItem.goal}`,
    `Inputs: ${workItem.inputs.join(", ")}`,
    `Scope: ${workItem.scope.join(", ")}`,
    `Success criteria: ${workItem.successCriteria.join("; ")}`,
    `Expected outputs: ${workItem.expectedOutputs.join(", ")}`
  ].join("\n");
}

export class HermesCliRunner extends HermesAgentRunner {
  constructor(options = {}) {
    super();
    this.name = "hermes-cli";
    this.command = options.command ?? "hermes";
    this.commandRunner = options.commandRunner ?? runCommand;
    this.fallback = options.fallback ?? new HermesAgentRunner();
  }

  async execute(workItem, runtimeContext) {
    if (!Array.isArray(workItem.scope) || workItem.scope.length === 0) {
      return this.fallback.execute(workItem, runtimeContext);
    }

    const prompt = buildHermesPrompt(workItem, runtimeContext);
    const result = await this.commandRunner(this.command, ["chat", "-q"], {
      cwd: runtimeContext.cwd,
      input: `${prompt}\n`
    });

    if (!result.ok || !result.stdout) {
      return this.fallback.execute(workItem, runtimeContext);
    }

    return {
      status: "completed",
      summary: result.stdout.split("\n")[0] ?? `Executed ${workItem.title} with hermes-cli.`,
      outputs: workItem.expectedOutputs,
      reviewStatus: "accepted",
      nextEvent: "review_result",
      metadata: {
        runner: this.name,
        provider: runtimeContext.provider.name,
        externalCommand: this.command
      },
      transcript: result.stdout
    };
  }
}
