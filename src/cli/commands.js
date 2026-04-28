import { DEFAULT_PORT } from "../core/constants.js";
import { SpecOrchestrator } from "../core/orchestrator.js";
import { spawnPassthrough } from "../utils/process.js";

function usage() {
  return `Usage:
  speculoss init
  speculoss config show
  speculoss config set <path> <json-value>
  speculoss spec create <title> [problem statement]
  speculoss spec sync <slug>
  speculoss spec refine <slug>
  speculoss plan generate <slug>
  speculoss tasks generate <slug>
  speculoss approve <slug> <spec|plan|task_batch>
  speculoss run start <slug>
  speculoss run status <slug>
  speculoss ui [port]`;
}

function print(value) {
  process.stdout.write(`${value}\n`);
}

export async function main(args, options = {}) {
  const orchestrator = options.orchestrator ?? new SpecOrchestrator({ cwd: options.cwd });
  const [command, subcommand, ...rest] = args;

  if (!command) {
    print(usage());
    return;
  }

  if (command === "init") {
    const root = await orchestrator.init();
    print(`Initialized speculoss in ${root}`);
    return;
  }

  if (command === "config" && subcommand === "show") {
    await orchestrator.ensureConfigured();
    print(JSON.stringify(orchestrator.config, null, 2));
    return;
  }

  if (command === "config" && subcommand === "set") {
    const [keyPath, rawValue] = rest;
    if (!keyPath || rawValue === undefined) {
      throw new Error("config set requires <path> <json-value>.");
    }
    const next = await orchestrator.configStore.load();
    const keys = keyPath.split(".");
    let cursor = next;
    while (keys.length > 1) {
      const key = keys.shift();
      cursor[key] ??= {};
      cursor = cursor[key];
    }
    cursor[keys[0]] = JSON.parse(rawValue);
    const saved = await orchestrator.configStore.save(next);
    orchestrator.configureFromConfig(saved);
    print(JSON.stringify(saved, null, 2));
    return;
  }

  if (command === "spec" && subcommand === "create") {
    const [title, ...problemParts] = rest;
    if (!title) {
      throw new Error("spec create requires a title.");
    }
    const project = await orchestrator.createSpec(title, problemParts.join(" "));
    print(JSON.stringify(project, null, 2));
    return;
  }

  if (command === "spec" && subcommand === "sync") {
    const slug = rest[0];
    if (!slug) {
      throw new Error("spec sync requires a slug.");
    }
    const project = await orchestrator.syncSpecFromSpecKit(slug);
    print(JSON.stringify(project, null, 2));
    return;
  }

  if (command === "spec" && subcommand === "refine") {
    const slug = rest[0];
    if (!slug) {
      throw new Error("spec refine requires a slug.");
    }
    const run = await orchestrator.refineSpec(slug);
    print(JSON.stringify(run, null, 2));
    return;
  }

  if (command === "plan" && subcommand === "generate") {
    const slug = rest[0];
    if (!slug) {
      throw new Error("plan generate requires a slug.");
    }
    const run = await orchestrator.generatePlan(slug);
    print(JSON.stringify(run, null, 2));
    return;
  }

  if (command === "tasks" && subcommand === "generate") {
    const slug = rest[0];
    if (!slug) {
      throw new Error("tasks generate requires a slug.");
    }
    const run = await orchestrator.generateTasks(slug);
    print(JSON.stringify(run, null, 2));
    return;
  }

  if (command === "approve") {
    const [slug, stage] = [subcommand, rest[0]];
    if (!slug || !stage) {
      throw new Error("approve requires <slug> <stage>.");
    }
    const run = await orchestrator.approve(slug, stage);
    print(JSON.stringify(run, null, 2));
    return;
  }

  if (command === "run" && subcommand === "start") {
    const slug = rest[0];
    if (!slug) {
      throw new Error("run start requires a slug.");
    }
    const run = await orchestrator.startRun(slug);
    print(JSON.stringify(run, null, 2));
    return;
  }

  if (command === "run" && subcommand === "status") {
    const slug = rest[0];
    if (!slug) {
      throw new Error("run status requires a slug.");
    }
    const status = await orchestrator.status(slug);
    print(JSON.stringify(status, null, 2));
    return;
  }

  if (command === "ui") {
    const port = Number.parseInt(subcommand ?? `${DEFAULT_PORT}`, 10);
    const code = await spawnPassthrough("pnpm", ["exec", "nuxt", "dev", "--port", `${port}`, "--host", "127.0.0.1"], {
      cwd: options.cwd
    });
    process.exitCode = code;
    return;
  }

  throw new Error(usage());
}
