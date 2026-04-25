# Inkrement 6 — Runtime integration, E2E, declarative approval gate

## Context

After Inkrement 5 (containerized runtime) plus the small add-ons in PR #1
(resource limits per agent + start endpoint), the runtime is **structurally
complete** but **never actually exercised end-to-end**. This plan covers
what's needed to flip it from "compiles, unit-tests pass" to "tasks dispatch
and produce artefacts, with the user genuinely able to start a company from
the UI".

**Open issues this addresses:**
1. Hermes install URL in Dockerfile.hermes-agent has never been verified
2. No E2E test of the full `task → CEO container → worker container → artefact` flow
3. CompanyRuntime can be started but never stopped (no stop/status endpoints)
4. ApprovalService is a placeholder; no user-notification channel
5. `process.cwd()` ≠ host path when haex-corp itself runs in Docker

## Goal & Non-Goals

### In Scope
- **Hermes URL verification + image build** in CI or locally
- **Path translation** for host-vs-container path mismatch
- **Stop & status endpoints** for company runtime lifecycle
- **Server-test harness** (decision: build it, or document that endpoints stay integration-tested manually)
- **Full E2E smoke test** that drops a task YAML and asserts an artefact appears
- **ApprovalService skeleton** with declarative configuration in agent spec
- CEO agent owns the user-notification logic (channel selection from Hermes-configured channels: signal, whatsapp, email, etc.)

### Out of Scope (defer further)
- Multi-tenant approval (multiple users per company)
- Approval audit log persistence beyond what EventStore already provides
- Per-channel templating / i18n
- Cron scheduling for `runner_type: scheduled` (still parked)

## Implementation Plan

### 6.1 — Verify Hermes install URL + first image build

`https://hermes-agent.nousresearch.com/install.sh` is currently the
`HERMES_INSTALL_URL` build-arg default. Steps:

1. `curl -I https://hermes-agent.nousresearch.com/install.sh` — confirm 200
2. `docker build -f Dockerfile.hermes-agent -t hermes-agent:dev .` locally
3. If install.sh is not at that exact URL: find the canonical install
   command (likely a `npm install -g`, a `cargo install`, or a different
   curl URL), update the Dockerfile, re-test
4. Once the image builds: run the four smoke tests in
   `tests/integration/docker-runner-smoke.test.js` — they should now pass
   instead of skipping
5. Trigger the GHCR workflow manually (`gh workflow run "Build hermes-agent image"`)
   to verify the CI build also succeeds

**Verify:** `docker run --rm hermes-agent:dev hermes --version` outputs a version.

### 6.2 — Path translation for in-container orchestrator

When haex-corp runs in Docker (`docker compose up`), `process.cwd()` is
`/app`. But bind mounts spawned via the docker-out-of-docker socket need
HOST paths. Currently `server/api/projects/[slug]/company/start.post.ts`
passes `projectCwd(slug)` = `/app/projects/<slug>` to dockerRunnerFactory,
which would mount **a path that doesn't exist on the host**.

Two options:

1. **Env-var-based translation:** add `HAEX_CORP_HOST_PROJECT_ROOT` to compose.
   `company-manager.ts` reads it at endpoint-call time and rewrites
   `/app/projects/X` → `<host-path>/projects/X`. Simple, explicit, opt-in.

2. **Fully host-mode:** require haex-corp to run with `--network=host`
   plus a bind-mount of `/var/run/docker.sock` AND a matching host path.
   More setup but fewer moving parts at runtime.

Recommend (1). Implementation:

- Read `HAEX_CORP_HOST_PROJECT_ROOT` in `start.post.ts`
- Pass translated path to dockerRunnerFactory
- Document the required env var in `docker-compose.yml`
- Test: unit-test the translation function in isolation

**Verify:** Start a company via the endpoint, observe a hermes-agent container
with bind mount pointing at the correct host path (`docker inspect <container>`).

### 6.3 — Stop & status endpoints

```
POST /api/projects/<slug>/company/stop
GET  /api/projects/<slug>/company/status
```

`stop.post.ts`:
- Look up active company by slug
- Call `runtime.stop()` — should drain the queue poller and signal CEO to wind down
- Deregister from company-manager
- Return `{status: "stopped"}`
- 404 if no active company for slug

`status.get.ts`:
- Active company → `{status: "running", agents: [...], queueDepth: N}` (queueDepth requires a small extension to QueuePoller exposing pending count)
- No active company → `{status: "idle"}`

CompanyRuntime.stop() exists but its emit("stopped") handler has no listener
yet. Add SSE bridge (parallel to run/start.post.ts) for live status updates.

### 6.4 — Server-test harness

Decision point: do we want unit tests for the endpoints?

**Option A — Set it up.** Use `@nuxt/test-utils` + Vitest. Adds a second
test runner alongside `node --test`. Tests run as full Nitro instances,
slow but realistic.

**Option B — Skip and document.** Endpoint logic stays thin (orchestration
only). Heavy lifting is in `src/core/` and `src/runners/` modules that
already have 130+ unit tests. Endpoints are integration-tested manually
or via 6.5 (E2E test). Document the convention.

Recommend **B for now**. The endpoint surface is small (start/stop/status)
and the orchestration logic is straightforward — the bugs that would matter
get caught by the E2E test in 6.5.

If we take A: add `pnpm test:server` script, set up `@nuxt/test-utils`,
write `tests/server/company-start.test.ts` first (smallest surface).

### 6.5 — Full E2E smoke test

`tests/integration/company-e2e.test.js`:

Prerequisites (skip-gated):
- Docker daemon reachable
- `hermes-agent:dev` image present
- Optional: `ANTHROPIC_API_KEY` set (skip if absent — without an LLM, the
  CEO can't reason about a real task)

Flow:
1. Set up a temp project with a minimal `.specify/org/{constitution.md, agents/ceo.md}`
2. Hit `POST /api/projects/<slug>/company/start` (or instantiate CompanyRuntime
   directly to skip the endpoint layer for the first test version)
3. Drop `<projectRoot>/.specops/<slug>/queue/echo.yaml` with a trivial goal
   (e.g. `goal: "write 'hello' to result.md"`)
4. Wait up to 60s for `<projectRoot>/result.md` to appear
5. Assert content contains "hello"
6. Stop the runtime, verify all containers are gone (`docker ps --filter name=hermes-agent_<slug>_*`)

**Cost note:** this hits the Anthropic API. Don't run it in tight test
loops — gate by env var `RUN_E2E_TESTS=1`.

### 6.6 — ApprovalService skeleton + per-agent declarative config

Currently `capability-gate.js` returns `requiresApproval: true` for
sensitive caps but no one calls an approval service on that signal.

The user clarified: **CEO owns the user-notification logic**, choosing a
channel from what Hermes has configured (signal, whatsapp, email, …).
That means:

1. **Per-agent declarative config in spec frontmatter:**
   ```yaml
   approval:
     timeout: "5m"           # how long the worker container blocks
     on_timeout: "deny"      # deny | escalate-to-ceo | retry-once
     notify_via: ["signal", "email"]   # channels CEO picks from
   ```

2. **`src/core/approval-service.js`** (skeleton — no actual notification yet):
   - `requestApproval({slug, agent, capability, requestPayload}) → Promise<{decision, by, at}>`
   - Persists request in event-store, returns a Promise that resolves when:
     - User explicitly approves/denies via UI/notification reply, OR
     - Timeout fires per agent's `approval.timeout`, applying `on_timeout`
   - Pluggable transport interface for actual channel implementations

3. **company-ops MCP server** (when added) calls ApprovalService whenever
   it sees `requiresApproval: true` from capability-gate. Worker container's
   MCP call blocks on this Promise.

4. **Notification transport stays out of this inkrement.** Stub interface
   only:
   ```js
   class NotificationTransport {
     async notify({channel, payload}) { /* Signal/Telegram/email impl */ }
   }
   ```
   Real implementations come later — Signal-CLI, gh-notifications,
   nodemailer, whatever.

**Verify:** Unit-test ApprovalService with synthetic transport (records
calls, records timeout fires). Integration-test that a `payment:execute_unrestricted`
capability call from a worker triggers an approval request that times out
correctly under the agent's `approval.timeout` setting.

## Open Questions

1. **MCP server lifecycle**: `company-ops` is referenced as the MCP server
   that worker containers call back to. Does it run in haex-corp itself,
   or as a separate sidecar? Current design assumes haex-corp.

2. **Approval-decision-source diversity**: when CEO notifies user via two
   channels (signal + email) and user replies on Signal, do we need to
   "cancel" the email-side request? Or is first-response-wins fine? Likely
   first-wins; other channels just get an auto "decided elsewhere" reply
   when polled.

3. **Queue-depth semantics**: the QueuePoller currently emits events for
   new files but doesn't track pending counts. Adding `getPendingCount()`
   is a small extension — but does it count files currently being processed,
   or only those waiting? Edge case for the status endpoint.

4. **Catalog discovery for companies that override**: per-company catalog
   overrides (deferred from earlier inkrements) — when does company-manager
   pick those up? Today catalogDir is hardcoded to `<repo-root>/catalog/`.

## Verification

```bash
# 6.1
curl -I https://hermes-agent.nousresearch.com/install.sh
docker build -f Dockerfile.hermes-agent -t hermes-agent:dev .
docker run --rm hermes-agent:dev hermes --version
node --test tests/integration/docker-runner-smoke.test.js

# 6.2
HAEX_CORP_HOST_PROJECT_ROOT=/home/haex/Projekte/haex-corp docker compose up -d
curl -X POST http://localhost:3000/api/projects/test/company/start
docker inspect hermes-agent_test_ceo | jq '.[0].Mounts'

# 6.3
curl http://localhost:3000/api/projects/test/company/status
curl -X POST http://localhost:3000/api/projects/test/company/stop

# 6.5
RUN_E2E_TESTS=1 ANTHROPIC_API_KEY=... node --test tests/integration/company-e2e.test.js

# 6.6
node --test tests/core/approval-service.test.js
```

## Critical Files Reference

- [src/core/company-runtime.js](../../src/core/company-runtime.js) — composition seam
- [src/runners/hermes-docker.js](../../src/runners/hermes-docker.js) — runner factory
- [server/utils/company-manager.ts](../../server/utils/company-manager.ts) — registry + module loaders
- [server/api/projects/[slug]/company/start.post.ts](../../server/api/projects/[slug]/company/start.post.ts) — pattern for sibling endpoints
- [server/api/projects/[slug]/run/start.post.ts](../../server/api/projects/[slug]/run/start.post.ts) — SSE pattern reference
- [src/core/capability-gate.js](../../src/core/capability-gate.js) — `requiresApproval` source
- [Dockerfile.hermes-agent](../../Dockerfile.hermes-agent) — `HERMES_INSTALL_URL` build-arg

## Out of Inkrement-6 (defer further)

- Cron / scheduled runs (`runner_type: scheduled`)
- Per-company catalog overrides (read-path change in catalog-loader)
- UI for company management — needs separate vertical
- Multi-host or Kubernetes deployment
- Real notification transports (Signal-CLI, Telegram bot, email gateway)
- Approval audit retention beyond EventStore defaults
