import { LocalTemplateProvider, ModelProvider } from "./base.js";
import { runCommand } from "../utils/process.js";

function buildFabricPrompt(stage, input, pattern) {
  return [
    `Stage: ${stage}`,
    `Pattern: ${pattern}`,
    "",
    "Context:",
    JSON.stringify(input, null, 2)
  ].join("\n");
}

export class FabricCliProvider extends ModelProvider {
  constructor(options = {}) {
    super("fabric-cli");
    this.command = options.command ?? "fabric";
    this.commandRunner = options.commandRunner ?? runCommand;
    this.fallback = options.fallback ?? new LocalTemplateProvider();
  }

  async generate(input, options = {}) {
    const patternName = options.pattern?.name?.replace(/^fabric:/, "") ?? options.stage ?? "analyze";
    const prompt = buildFabricPrompt(options.stage ?? "generic", input, patternName);
    const result = await this.commandRunner(this.command, ["--pattern", patternName], {
      cwd: options.cwd,
      input: prompt
    });

    if (!result.ok || !result.stdout) {
      return this.fallback.generate(input, options);
    }

    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

    if (options.stage === "spec_refine") {
      return {
        summary: lines[0] ?? `Fabric refinement for ${input.title}.`,
        notes: lines.slice(0, 3)
      };
    }

    if (options.stage === "run_review") {
      return {
        summary: lines[0] ?? "Fabric review completed.",
        recommendation: lines[1] ?? "Review the run output."
      };
    }

    return this.fallback.generate(input, options);
  }
}
