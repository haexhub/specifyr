/**
 * POST /api/projects/<slug>/company/start
 *
 * Boots the speckit-company runtime for this project. Looks up the project
 * directory by slug, then instantiates CompanyRuntime with the docker runner
 * factory so each agent runs in its own hermes-agent container.
 *
 * Returns once `runtime.start()` has finished provisioning agent profile
 * dirs and starting the queue poller — does NOT wait for any agent to
 * dispatch a task. The caller (UI) gets the agent roster back and can
 * monitor activity via subsequent endpoints (deferred).
 *
 * Lifecycle: one CompanyRuntime per slug for the process lifetime. Calling
 * start twice on the same slug returns 409. Stop endpoint not yet
 * implemented — restart requires `docker compose restart haex-corp`.
 *
 * Path layout convention (matches existing endpoints):
 *   <projectCwd>/.specify/org/                  org dir (constitution + agents)
 *   <projectCwd>/.specops/<slug>/queue/         task queue
 *   <repo-root>/catalog/                        global catalog (shared)
 */

import {
  projectCwd,
  projectHostCwd,
  assertProjectExists,
} from "../../../../utils/specops-stores";
import {
  getCompanyRuntimeModule,
  getDockerRunnerFactoryModule,
  getActiveCompany,
  registerCompany,
} from "../../../../utils/company-manager";
import path from "node:path";

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, "slug");
  if (!slug) {
    throw createError({ statusCode: 400, statusMessage: "Missing slug" });
  }

  await assertProjectExists(slug);

  if (getActiveCompany(slug)) {
    throw createError({
      statusCode: 409,
      statusMessage: `Company runtime already running for project '${slug}'`,
    });
  }

  // Container-side paths: used by Node code in haex-corp itself (mkdir,
  // readFile, watchers). When running natively on the host these equal the
  // host paths.
  const pCwd = projectCwd(slug);
  const orgDir = path.join(pCwd, ".specify", "org");
  const queueDir = path.join(process.cwd(), ".specops", slug, "queue");
  const catalogDir = path.join(process.cwd(), "catalog");

  // Host-side path: passed to dockerRunnerFactory because the Docker daemon
  // resolves bind-mount sources against the HOST filesystem, not against
  // haex-corp's container view. See specops-stores.ts:hostProjectRoot.
  const pHostCwd = projectHostCwd(slug);

  const { CompanyRuntime } = await getCompanyRuntimeModule();
  const { dockerRunnerFactory } = await getDockerRunnerFactoryModule();

  const runnerFactory = dockerRunnerFactory({
    projectRoot: pHostCwd,
    network: "companies",
    // image resolved via factory: explicit > HERMES_AGENT_IMAGE > hermes-agent:dev
  });

  const runtime = new CompanyRuntime({
    projectRoot: pCwd,
    orgDir,
    queueDir,
    catalogDir,
    runnerFactory,
  });

  try {
    await runtime.start();
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: err instanceof Error ? err.message : "Company runtime failed to start",
    });
  }

  registerCompany(slug, runtime);

  return {
    status: "started",
    slug,
    agents: runtime.listAgents().map((a) => ({
      role: a.role,
      capabilities: a.capabilities,
      resources: a.resources ?? null,
    })),
  };
});
