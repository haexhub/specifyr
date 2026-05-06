import { ArtifactStore } from "./artifact-store.js";
import { ApprovalService } from "./approval-service.js";
import { ConfigStore } from "./config.js";
import { EventStore } from "./event-store.js";
import { PatternResolver } from "./pattern-resolver.js";
import { SpecKitBridge } from "./spec-kit-bridge.js";
import { APPROVAL_STAGES, RUN_STATUSES, WORKFLOW_STAGES } from "./constants.js";
import { createPlanMarkdown, createSpecTemplate, createTasksMarkdown, extractJsonBlock, extractSection, parseBullets } from "./markdown.js";
import { LocalTemplateProvider, OpenAICompatibleProvider } from "../providers/base.js";
import { HermesAgentRunner } from "../runners/base.js";
import { FabricCliProvider } from "../providers/fabric.js";
import { slugify } from "../utils/fs.js";

function assertStatus(status) {
  if (!RUN_STATUSES.includes(status)) {
    throw new Error(`Invalid status '${status}'.`);
  }
}

function createRun(slug) {
  return {
    slug,
    currentStage: "draft",
    status: "draft",
    approvals: [],
    completedTaskIds: [],
    failedTaskIds: [],
    taskResults: {},
    updatedAt: new Date().toISOString()
  };
}

export class SpecOrchestrator {
  constructor(options = {}) {
    this.store = options.store ?? new ArtifactStore(options.cwd);
    this.configStore = options.configStore ?? new ConfigStore(options.cwd);
    this.approvals = options.approvals ?? new ApprovalService();
    this.specKit = options.specKit ?? new SpecKitBridge(options.cwd);
    this.commandRunner = options.commandRunner;
    this.patterns = options.patterns ?? null;
    this.provider = options.provider ?? null;
    this.providers = {
      local: options.localProvider ?? new LocalTemplateProvider(),
      openaiCompatible: options.openaiCompatibleProvider ?? new OpenAICompatibleProvider()
    };
    this.runner = options.runner ?? null;
    this.cwd = options.cwd ?? process.cwd();
  }

  async init() {
    await this.store.initRoot();
    const config = await this.configStore.save(await this.configStore.load());
    await this.specKit.init();
    this.configureFromConfig(config);
    return this.store.rootDir;
  }

  async createSpec(title, problemStatement = "") {
    await this.ensureConfigured();
    const slug = slugify(title);
    if (!slug) {
      throw new Error("Could not derive a slug from the title.");
    }
    const specContent = createSpecTemplate(title, slug, problemStatement);
    await this.store.createProject(slug, title, specContent);
    const run = createRun(slug);
    await this.store.saveArtifact(slug, "run", run);
    await this.syncSpecKit(slug, { title, spec: specContent, plan: "", tasks: "" });
    const events = new EventStore(this.store.getProjectDir(slug));
    await events.append(this.createEvent("spec.created", "system", { slug, title }));
    return { slug, title };
  }

  async refineSpec(slug) {
    await this.ensureConfigured();
    const { spec, run } = await this.loadProjectContext(slug);
    const pattern = this.patterns.resolve(WORKFLOW_STAGES.SPEC_REFINE, { slug });
    const result = await this.provider.generate(spec, { stage: "spec_refine", pattern });
    const refinedSpec = `${spec.raw.trim()}\n\n## Refinement Notes\n${result.notes.map((note) => `- ${note}`).join("\n")}\n`;
    const nextRun = this.updateRun(run, "refined");
    await this.store.saveArtifact(slug, "spec", refinedSpec);
    await this.store.saveArtifact(slug, "run", nextRun);
    await this.syncArtifacts(slug);
    const events = new EventStore(this.store.getProjectDir(slug));
    await events.append(this.createEvent("spec.refined", "orchestrator", { pattern: pattern.name, provider: this.provider.name }));
    return nextRun;
  }

  async generatePlan(slug) {
    await this.ensureConfigured();
    const { spec, run } = await this.loadProjectContext(slug);
    const pattern = this.patterns.resolve(WORKFLOW_STAGES.PLAN_GENERATE, { slug });
    const planData = await this.provider.generate(spec, { stage: "plan_generate", pattern });
    const planMarkdown = createPlanMarkdown(spec, planData);
    const nextRun = this.updateRun(run, "planned");
    await this.store.saveArtifact(slug, "plan", planMarkdown);
    await this.store.saveArtifact(slug, "run", nextRun);
    await this.syncArtifacts(slug);
    const events = new EventStore(this.store.getProjectDir(slug));
    await events.append(this.createEvent("plan.generated", "orchestrator", { pattern: pattern.name, provider: this.provider.name }));
    return nextRun;
  }

  async generateTasks(slug) {
    await this.ensureConfigured();
    const { spec, plan, run } = await this.loadProjectContext(slug);
    if (!plan.data) {
      throw new Error("Plan is missing or invalid. Generate a plan first.");
    }
    const pattern = this.patterns.resolve(WORKFLOW_STAGES.TASKS_GENERATE, { slug });
    const tasksData = await this.provider.generate(
      { title: spec.title, phases: plan.data.phases },
      { stage: "tasks_generate", pattern }
    );
    const tasksMarkdown = createTasksMarkdown(spec, tasksData);
    await this.store.saveArtifact(slug, "tasks", tasksMarkdown);
    const nextRun = this.updateRun(run, "planned");
    await this.store.saveArtifact(slug, "run", nextRun);
    await this.syncArtifacts(slug);
    const events = new EventStore(this.store.getProjectDir(slug));
    await events.append(this.createEvent("tasks.generated", "orchestrator", { pattern: pattern.name, provider: this.provider.name }));
    return nextRun;
  }

  async approve(slug, stage, actor = "human") {
    await this.ensureConfigured();
    if (!APPROVAL_STAGES.includes(stage)) {
      throw new Error(`Approval stage must be one of: ${APPROVAL_STAGES.join(", ")}.`);
    }
    const run = await this.store.loadArtifact(slug, "run", null);
    if (!run) {
      throw new Error(`Unknown project '${slug}'.`);
    }
    const nextRun = this.approvals.approve(run, stage, actor);
    if (this.approvals.hasApproval(nextRun, "spec") && this.approvals.hasApproval(nextRun, "plan") && this.approvals.hasApproval(nextRun, "task_batch")) {
      nextRun.currentStage = "approved_for_execution";
      nextRun.status = "approved_for_execution";
    }
    nextRun.updatedAt = new Date().toISOString();
    await this.store.saveArtifact(slug, "run", nextRun);
    await this.store.saveArtifact(slug, "approvals", nextRun.approvals);
    const events = new EventStore(this.store.getProjectDir(slug));
    await events.append(this.createEvent("approval.granted", actor, { stage }));
    return nextRun;
  }

  async startRun(slug) {
    await this.ensureConfigured();
    const context = await this.loadProjectContext(slug);
    const { run, tasks } = context;
    if (!this.approvals.hasApproval(run, "task_batch")) {
      throw new Error("Run cannot start before task_batch approval.");
    }
    if (!tasks.data || tasks.data.tasks.length === 0) {
      throw new Error("No tasks found. Generate tasks first.");
    }
    const events = new EventStore(this.store.getProjectDir(slug));
    const startingRun = this.updateRun(run, "running");
    await this.store.saveArtifact(slug, "run", startingRun);
    await events.append(this.createEvent("run.started", "orchestrator", { totalTasks: tasks.data.tasks.length }));

    const taskMap = new Map(tasks.data.tasks.map((task) => [task.id, task]));
    const completed = new Set(startingRun.completedTaskIds);
    const failed = new Set(startingRun.failedTaskIds);
    const taskResults = { ...startingRun.taskResults };

    while (completed.size + failed.size < taskMap.size) {
      const readyTasks = tasks.data.tasks.filter((task) => {
        if (completed.has(task.id) || failed.has(task.id)) {
          return false;
        }
        return task.dependencies.every((dependency) => completed.has(dependency));
      });

      if (readyTasks.length === 0) {
        const blockedRun = {
          ...startingRun,
          currentStage: "blocked",
          status: "blocked",
          completedTaskIds: [...completed],
          failedTaskIds: [...failed],
          taskResults,
          updatedAt: new Date().toISOString()
        };
        await this.store.saveArtifact(slug, "run", blockedRun);
        await events.append(this.createEvent("run.blocked", "orchestrator", { reason: "No ready tasks remain." }));
        return blockedRun;
      }

      const results = await Promise.all(
        readyTasks.map(async (task) => {
          const pattern = this.patterns.resolve(WORKFLOW_STAGES.RUN_EXECUTION, { slug, taskId: task.id });
          const outcome = await this.runner.execute(task, {
            slug,
            pattern,
            provider: this.provider,
            cwd: this.cwd
          });
          return { task, pattern, outcome };
        })
      );

      for (const { task, pattern, outcome } of results) {
        taskResults[task.id] = outcome;
        await events.append(this.createEvent("task.executed", this.runner.name, {
          taskId: task.id,
          taskTitle: task.title,
          pattern: pattern.name,
          status: outcome.status,
          reviewStatus: outcome.reviewStatus
        }));
        if (outcome.status === "completed" && task.expectedOutputs.length > 0) {
          completed.add(task.id);
        } else {
          failed.add(task.id);
        }
      }
    }

    const reviewPattern = this.patterns.resolve(WORKFLOW_STAGES.RUN_REVIEW, { slug });
    const review = await this.provider.generate(
      { slug, completed: completed.size, failed: failed.size, total: tasks.data.tasks.length },
      { stage: "run_review", pattern: reviewPattern }
    );

    const finalStatus = failed.size > 0 ? "failed" : "completed";
    const finalRun = {
      ...startingRun,
      currentStage: finalStatus,
      status: finalStatus,
      completedTaskIds: [...completed],
      failedTaskIds: [...failed],
      taskResults,
      updatedAt: new Date().toISOString()
    };
    await this.store.saveArtifact(slug, "run", finalRun);
    await this.store.saveArtifact(slug, "results", { tasks: taskResults, summary: review });
    await events.append(this.createEvent("run.finished", "orchestrator", { status: finalStatus, review }));
    return finalRun;
  }

  async status(slug) {
    await this.ensureConfigured();
    const context = await this.loadProjectContext(slug);
    const events = new EventStore(this.store.getProjectDir(slug));
    return {
      slug,
      title: context.meta.title,
      run: context.run,
      approvals: context.run.approvals,
      tasks: context.tasks.data?.tasks ?? [],
      events: await events.list()
    };
  }

  async listProjects() {
    await this.ensureConfigured();
    return this.store.listProjects();
  }

  async syncSpecFromSpecKit(slug, title = null) {
    await this.ensureConfigured();
    const specContent = await this.specKit.readSpec(slug);
    if (!specContent.trim()) {
      throw new Error(`No spec-kit spec found for '${slug}'.`);
    }

    const existingMeta = await this.store.loadArtifact(slug, "meta", null);
    const resolvedTitle = title ?? existingMeta?.title ?? this.titleFromSpec(specContent, slug);

    if (!existingMeta) {
      await this.store.createProject(slug, resolvedTitle, specContent);
      await this.store.saveArtifact(slug, "run", createRun(slug));
    } else {
      await this.store.saveArtifact(slug, "spec", specContent);
    }

    const run = await this.store.loadArtifact(slug, "run", null);
    const nextRun = this.updateRun(run, "draft");
    await this.store.saveArtifact(slug, "run", nextRun);
    const events = new EventStore(this.store.getProjectDir(slug));
    await events.append(this.createEvent("spec.synced_from_spec_kit", "spec-kit", { slug }));
    await this.syncArtifacts(slug);
    return { slug, title: resolvedTitle };
  }

  async projectSnapshot(slug) {
    await this.ensureConfigured();
    const context = await this.loadProjectContext(slug);
    const events = new EventStore(this.store.getProjectDir(slug));
    return {
      slug,
      title: context.meta.title,
      description: context.meta.description ?? "",
      projectRoot: context.meta.projectRoot ?? null,
      specifyInit: context.meta.specifyInit ?? null,
      spec: context.spec.raw,
      plan: context.plan.raw,
      tasks: context.tasks.raw,
      run: context.run,
      results: await this.store.loadArtifact(slug, "results", { tasks: {}, summary: null }),
      events: await events.list()
    };
  }

  async loadProjectContext(slug) {
    await this.ensureConfigured();
    const meta = await this.store.loadArtifact(slug, "meta", null);
    if (!meta) {
      throw new Error(`Unknown project '${slug}'.`);
    }
    const specRaw = await this.store.loadArtifact(slug, "spec", "");
    const planRaw = await this.store.loadArtifact(slug, "plan", "");
    const tasksRaw = await this.store.loadArtifact(slug, "tasks", "");
    const run = await this.store.loadArtifact(slug, "run", null);
    if (!run) {
      throw new Error(`Run state for '${slug}' is missing.`);
    }
    assertStatus(run.status);
    return {
      meta,
      spec: this.parseSpec(meta.title, specRaw),
      plan: { raw: planRaw, data: planRaw ? extractJsonBlock(planRaw) : null },
      tasks: { raw: tasksRaw, data: tasksRaw ? extractJsonBlock(tasksRaw) : null },
      run
    };
  }

  parseSpec(title, raw) {
    return {
      title,
      raw,
      problem: extractSection(raw, "Problem"),
      goals: parseBullets(extractSection(raw, "Goals")),
      constraints: parseBullets(extractSection(raw, "Constraints")),
      acceptanceCriteria: parseBullets(extractSection(raw, "Acceptance Criteria"))
    };
  }

  updateRun(run, status) {
    assertStatus(status);
    return {
      ...run,
      currentStage: status,
      status,
      updatedAt: new Date().toISOString()
    };
  }

  createEvent(type, actor, payload) {
    return {
      type,
      actor,
      payload,
      timestamp: new Date().toISOString()
    };
  }

  titleFromSpec(raw, fallback) {
    const match = raw.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? fallback;
  }

  async ensureConfigured() {
    if (this.provider && this.runner && this.patterns) {
      return;
    }
    const config = await this.configStore.load();
    this.configureFromConfig(config);
  }

  configureFromConfig(config) {
    this.config = config;
    this.patterns = this.patterns ?? new PatternResolver(config.patterns);
    if (!this.provider) {
      this.provider =
        config.integrations.fabric.enabled
          ? new FabricCliProvider({
              command: config.integrations.fabric.command,
              commandRunner: this.commandRunner,
              fallback: this.providers.local
            })
          : this.providers.local;
    }
    if (!this.runner) {
      this.runner = new HermesAgentRunner();
    }
  }

  async syncArtifacts(slug) {
    const meta = await this.store.loadArtifact(slug, "meta", null);
    if (!meta || this.config?.integrations?.specKitSync === false) {
      return;
    }
    const spec = await this.store.loadArtifact(slug, "spec", "");
    const plan = await this.store.loadArtifact(slug, "plan", "");
    const tasks = await this.store.loadArtifact(slug, "tasks", "");
    await this.syncSpecKit(slug, { title: meta.title, spec, plan, tasks });
  }

  async syncSpecKit(slug, artifacts) {
    const config = this.config ?? (await this.configStore.load());
    if (config.integrations.specKitSync === false) {
      return;
    }
    await this.specKit.syncProject(slug, artifacts);
  }
}
