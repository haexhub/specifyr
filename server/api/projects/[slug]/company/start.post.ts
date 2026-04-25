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

  const pCwd = projectCwd(slug);
  const orgDir = path.join(pCwd, ".specify", "org");
  const queueDir = path.join(process.cwd(), ".specops", slug, "queue");
  const catalogDir = path.join(process.cwd(), "catalog");

  const { CompanyRuntime } = await getCompanyRuntimeModule();
  const { dockerRunnerFactory } = await getDockerRunnerFactoryModule();

  const runnerFactory = dockerRunnerFactory({
    projectRoot: pCwd,
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
