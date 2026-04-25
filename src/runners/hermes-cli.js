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
  /**
   * @param {object} options
   * @param {string} [options.command]       hermes binary, default 'hermes'
   * @param {string} [options.memoryRoot]    HERMES_HOME for this runner instance.
   *                                         When per-agent isolation is wanted,
   *                                         pass `hermesHomeForAgent({projectRoot, role})`.
   * @param {Function} [options.commandRunner]
   * @param {AgentRunner} [options.fallback]
   */
  constructor(options = {}) {
    super();
    this.name = "hermes-cli";
    this.command = options.command ?? "hermes";
    this.commandRunner = options.commandRunner ?? runCommand;
    this.fallback = options.fallback ?? new HermesAgentRunner();
    this.memoryRoot = options.memoryRoot ?? null;
  }

  async execute(workItem, runtimeContext) {
    if (!Array.isArray(workItem.scope) || workItem.scope.length === 0) {
      return this.fallback.execute(workItem, runtimeContext);
    }

    const prompt = buildHermesPrompt(workItem, runtimeContext);
    const env = this.memoryRoot ? { HERMES_HOME: this.memoryRoot } : undefined;
    const result = await this.commandRunner(this.command, ["chat", "-q"], {
      cwd: runtimeContext.cwd,
      input: `${prompt}\n`,
      env
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
