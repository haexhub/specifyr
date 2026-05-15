import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * In-memory registry of active run schedulers, keyed by (orgId, slug).
 * Project slugs are unique per organization, so the composite key is required
 * to avoid cross-org collisions on identically-named projects.
 * A scheduler is created when a run starts and cleaned up on completion/cancel.
 */

interface SchedulerModule {
  RunScheduler: new (opts: {
    cwd: string;
    orgId: string;
    slug: string;
    projectCwd: string;
    graph: unknown;
    runnerFactory?: unknown;
  }) => SchedulerInstance;
}

interface SchedulerInstance {
  execute(): Promise<void>;
  cancel(): void;
  on(event: string, listener: (payload: unknown) => void): void;
  off(event: string, listener: (payload: unknown) => void): void;
  removeAllListeners(event?: string): void;
}

interface TaskGraphModule {
  getOrBuildTaskGraph(opts: { cwd?: string; orgId: string; slug: string; projectCwd: string }): Promise<unknown>;
  loadTaskGraph(opts: { cwd?: string; orgId: string; slug: string }): Promise<unknown>;
}

interface RunStoreModule {
  RunStore: new (cwd?: string) => {
    getCurrent(orgId: string, slug: string): Promise<any>;
    saveCurrent(orgId: string, slug: string, state: any): Promise<any>;
    initFromGraph(orgId: string, slug: string, graph: any): Promise<any>;
    readTaskLog(orgId: string, slug: string, taskId: string): Promise<any[]>;
    setRunStatus(orgId: string, slug: string, patch: any): Promise<any>;
  };
}

async function loadEsm<T>(rel: string): Promise<T> {
  const url = pathToFileURL(path.join(process.cwd(), rel)).href;
  return import(url) as Promise<T>;
}

export async function getSchedulerModule() {
  return loadEsm<SchedulerModule>("src/core/run-scheduler.js");
}

export async function getTaskGraphModule() {
  return loadEsm<TaskGraphModule>("src/core/task-graph.js");
}

export async function getRunStoreModule() {
  return loadEsm<RunStoreModule>("src/core/run-store.js");
}

const registry = new Map<string, SchedulerInstance>();

function schedulerKey(orgId: string, slug: string): string {
  return `${orgId}/${slug}`;
}

export function getActiveScheduler(orgId: string, slug: string): SchedulerInstance | undefined {
  return registry.get(schedulerKey(orgId, slug));
}

export function registerScheduler(orgId: string, slug: string, scheduler: SchedulerInstance) {
  registry.set(schedulerKey(orgId, slug), scheduler);
}

export function deregisterScheduler(orgId: string, slug: string) {
  registry.delete(schedulerKey(orgId, slug));
}
