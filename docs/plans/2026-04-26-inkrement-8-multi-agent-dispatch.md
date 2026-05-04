# Inkrement 8 — Multi-Agent Dispatch

## Status

- **8.1 — Generalize QueuePoller registration: ✅ landed (2026-04-27)**
  - `queueDir` → `queueDirs: { [role]: dir }` (hard rename, no shim)
  - One QueuePoller per role; events tagged with role; `_dispatchToCEO` → `_dispatchToRole`
  - Per-role queue dir convention: `<root>/.specifyr/<slug>/queue-<role>/`
  - 6 new tests added; 180/180 baseline green
- **8.2 — Per-role serial dispatch state: ✅ landed (2026-04-27)**
  - `_dispatchQueue`/`_dispatching` → `Map<role, ...>`; `_inFlightPaths` stays global
  - `_processNextDispatch(role)` is re-entrant per role; same-role guard prevents double-drain, different roles run in parallel
  - New test verifies 2 roles' tasks are simultaneously in-flight (parked-promise pattern)
  - 181/181 baseline green
- **8.3 — `POST /mcp/<slug>/dispatch` endpoint: ✅ landed (2026-04-27)**
  - Pure helpers in `src/core/mcp-dispatch.js`: `validateDispatchBody`,
    `buildTaskId`, `buildDispatchYaml`
  - HTTP handler at `server/api/mcp/[slug]/dispatch.post.ts`
  - `source: "agent:<ceoRole>"` injected authoritatively (caller cannot
    override) — aligns with 10a audit trail
  - 14 helper unit tests; HTTP handler thin per project convention
  - No idempotency in v1 (retries → duplicate tickets, accepted)
- **8.4 — Multi-agent E2E test: ✅ landed (2026-04-27)**
  - **8.4a smoketest** (always runs): stub-runner factory; CEO uses
    `buildDispatchYaml`+`buildTaskId` to drop into dev queue; dev writes
    artefact. Validates the multi-agent flow mechanics in <200ms, no
    LLM/Docker dependency. CI-runnable.
  - **8.4b LLM E2E** (gated by `RUN_E2E_TESTS=1`): real Docker
    containers + real Anthropic. Test spawns a Node http server that
    mounts the dispatch endpoint logic; CEO container reaches it via
    Linux Docker bridge gateway (172.17.0.1, configurable). CEO prompt
    contains literal curl invocation; CEO calls dispatch endpoint;
    dev container picks up sub-task; dev writes artefact.
    Local-only (CI cannot pay for tokens).
  - 202 tests total (200 pass + 2 E2E skipped without env gates)
- **8.5 — Tests for the dispatch endpoint logic: ✅ landed with 8.3** (helpers fully covered;
  HTTP handler stays manually-tested per project convention)

## Open Questions — resolved

1. **Queue dir rename**: queue/ → queue-ceo/. ✅ done in 8.1.
2. **Concurrent dispatches per role / `runner_type: parallel`**:
   defer; today no agent uses parallel. TODO in dispatch loop.
3. **Task ID format**: `<UTC-ISO-no-colons>-<8hex>.yaml`,
   e.g. `2026-04-27T10-30-45-123Z-a1b2c3d4.yaml`. Sortable + collision-safe.
4. **CEO-knows-the-token**: ACK; token is callback credential, not
   privacy secret. No code change.

## Context

After this session's work (Inkrement 6 + 7.1/7.2):
- The runtime integration end-to-end works: CEO container picks up tasks
  from the queue, calls Anthropic, writes artefacts, exits cleanly
  (E2E test green at ~17s).
- The MCP server foundation exists: `POST /mcp/<slug>/authorize` and
  `GET /mcp/<slug>/agents` are bearer-auth'd and read from
  `CapabilityApprovalService` + `CompanyRuntime`.
- Workers receive `COMPANY_OPS_TOKEN` + `COMPANY_OPS_URL` via secretsResolver
  but have no tool wiring on the Hermes side yet, and no way to dispatch
  sub-tasks back through the system.

**The gap that defines this inkrement:** CEO has no way to delegate
work to other agents. The whole architecture assumes a CEO-as-orchestrator
pattern, but today `runners.get('ceo')` is the only path that ever runs.

## Goal & Non-Goals

### In scope (this session)
- **Per-role queue dirs**: `<projectRoot>/.specifyr/<slug>/queue-<role>/`
  with one QueuePoller per role; CEO queue stays at `queue/` for
  backwards-compat
- **Generalize dispatch loop** in CompanyRuntime: `_dispatchToCEO` becomes
  `_dispatchToRole(role, evt)`, dispatcher tracks per-role serial queues
- **`POST /mcp/<slug>/dispatch` endpoint**: CEO posts `{worker, task}`,
  the server writes the YAML into `queue-<worker>/`, the per-role poller
  picks it up
- **Multi-agent E2E test**: CEO YAML "delegate to dev: write hello" →
  CEO calls dispatch → dev container runs → dev writes file → both
  artefacts on disk

### Out of scope (defer to Inkrement 9)
- Hermes-side catalog wiring (7.4) — needs research on Hermes 0.11 HTTP-MCP
  support; for the E2E we can have CEO call the dispatch endpoint via its
  `code_execution` skill (curl/python `requests`) until proper MCP wiring
  lands
- Notification transports (Signal/Email/Telegram) for the ApprovalService
- Per-role resource limits beyond what's already in the agent spec
- Worker-to-worker dispatch (everything routes via CEO for now — single
  authority, single audit trail)
- Approval UI (visual approval flow)

## Implementation Plan

### 8.1 — Generalize QueuePoller registration

`CompanyRuntime` currently creates one poller for `queueDir`. Refactor:

- Accept `queueDirs: { [role]: dir }` instead of single `queueDir`, OR
  keep `queueDir` for backwards-compat (CEO) and add `getRoleQueueDir(role)`
- During `start()`, mkdir + spawn one poller per agent role
- Track them in `this.pollers = new Map<role, QueuePoller>`
- Each poller's `task` event carries the role; `_processNextDispatch`
  routes to the right runner

**Decide:** keep the existing CEO queue at `queue/` (legacy) or rename to
`queue-ceo/` for symmetry. Renaming means a one-time migration but
cleaner code. Recommend rename — there's no production data yet.

### 8.2 — Per-role serial dispatch state

Today's single `_dispatchQueue` and `_dispatching` flag generalise to
per-role:

```js
this._dispatchQueues = new Map(); // role -> [{path, task}]
this._dispatching = new Map();    // role -> boolean
this._inFlightPaths = new Set();  // unchanged: dedup across all roles
```

Each role's queue progresses independently — CEO can be processing one
task while a worker handles another. This is correct: agent containers
are isolated, no shared state.

**Verify:** add a test that drops 1 task per role and asserts they run
concurrently (max-in-flight = N roles, not 1).

### 8.3 — `POST /mcp/<slug>/dispatch` endpoint

```
POST /api/mcp/<slug>/dispatch
Authorization: Bearer <COMPANY_OPS_TOKEN>
Body: { worker: "dev", task: { goal: "...", expected_outputs: [...], ... } }

200 → { dispatched: true, role: "dev", path: "<projectRoot>/.specifyr/<slug>/queue-dev/<id>.yaml" }
400 → unknown role / missing fields
404 → no active runtime
```

Implementation:
- Reuse `requireRuntimeAuth`
- Validate `worker` is a known role in `runtime.listAgents()`
- Generate task ID (timestamp + random; or hash of body for idempotency)
- Write YAML to `<projectRoot>/.specifyr/<slug>/queue-<worker>/<id>.yaml`
- The per-role QueuePoller picks it up via chokidar — no direct call
  into runtime needed

**Idempotency note:** if CEO retries the same dispatch (network blip, etc.),
should we dedup by task content? Probably yes via `task_id` field in the
body. Out of scope for first version — accept duplicates, document.

### 8.4 — Multi-agent E2E test

Extend `tests/integration/company-e2e.test.js` (or new
`company-multi-agent.test.js`):

1. Fixture: org with CEO + Dev agents
   - CEO: `tools.builtin: [Read, Write]`, can call HTTP via Python skill
   - Dev: `tools.builtin: [Read, Write]`, capabilities for file write
2. Drop task: `goal: "Delegate to dev: write 'hello from dev' into dev-result.md"`
3. CEO container starts, reasons, calls `POST /mcp/<slug>/dispatch` with
   `worker: "dev"` and a worker-task
4. Dev container runs, writes `dev-result.md`
5. Test waits for `dev-result.md` to appear (up to 90s), asserts content
6. Stop runtime, verify both queue dirs are empty (tasks consumed)

**Cost note:** this hits Anthropic twice (CEO + Dev). Same cost gate as
existing E2E (`RUN_E2E_TESTS=1`). Likely runs ~30s.

The CEO needs to know to call the dispatch endpoint. Two ways:
- **A)** Bake instructions into the CEO's prompt template ("when you
  need to delegate, POST to $COMPANY_OPS_URL/dispatch with bearer
  $COMPANY_OPS_TOKEN")
- **B)** Wait for proper Hermes MCP wiring (Inkrement 9)

Go with **A** for the first pass — it works without Hermes-side config.
Update `buildHermesPrompt` to include the dispatch instructions when the
agent's capabilities suggest delegation is expected (e.g. `delegation:dispatch`
capability or check for the env vars).

### 8.5 — Tests for the dispatch endpoint logic

Pure-helper level (not full HTTP):
- Validate `task` body shape
- Compute target queue path correctly
- Reject unknown roles before touching disk

The endpoint itself (Nuxt handler) stays manually-tested per project
convention; its logic is thin.

## Open Questions

1. **Queue dir rename**: `queue/` → `queue-ceo/` or keep CEO at
   `queue/`? Cleaner to rename, but the existing E2E test fixtures and
   plan docs reference `queue/`. Decide first.

2. **Concurrent dispatches per role**: Plan says serial-per-role.
   Should `runner_type: parallel` agents (defined in spec but not yet
   honored) bypass that? Probably yes when we add support; today no
   agent spec uses parallel.

3. **Task ID format**: timestamp+random (`2026-04-26T10-30-45-abc.yaml`)
   or pure UUID? Timestamp-prefixed gives natural sort order in
   `ls queue-dev/` which is helpful for debugging.

4. **CEO-knows-the-token**: The CEO container has the token in env
   (`COMPANY_OPS_TOKEN`). It also has full filesystem read on
   `/workspace`. So the token is reachable from anywhere the agent
   could write to. Acceptable trade-off (the threat model assumes the
   agent is trusted; the token is a callback credential, not a
   privacy secret).

## Verification

```bash
# 8.1+8.2 — multi-poller + dispatch
node --test tests/company-runtime.test.js   # extended cases
node --test tests/queue-poller.test.js       # unchanged

# 8.3 — endpoint logic
node --test tests/mcp-dispatch.test.js       # new

# 8.4 — multi-agent E2E (live LLM)
ANTHROPIC_API_KEY="$(node -e 'console.log(require(process.env.HOME+"/.claude/.credentials.json").claudeAiOauth.accessToken)')" \
  RUN_E2E_TESTS=1 node --test tests/integration/company-multi-agent.test.js

# manual via curl
TOKEN=$(...)
curl -X POST http://localhost:3000/api/mcp/myproject/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"worker":"dev","task":{"goal":"write hello","expected_outputs":["x.md"]}}'
ls -la projects/myproject/.specifyr/myproject/queue-dev/
```

## Critical Files Reference

- [src/core/company-runtime.js](../../src/core/company-runtime.js)
  — queue-dirs, dispatch generalisation, per-role state
- [src/core/queue-poller.js](../../src/core/queue-poller.js)
  — already extended with `getPendingCount()`; may need a role label
- [server/api/mcp/[slug]/](../../server/api/mcp/[slug]/)
  — new dispatch.post.ts goes here
- [server/utils/mcp-auth.ts](../../server/utils/mcp-auth.ts)
  — reused as-is
- [tests/integration/company-e2e.test.js](../../tests/integration/company-e2e.test.js)
  — sibling new test for multi-agent

## Out of Inkrement-8 (defer further)

- Hermes catalog HTTP-MCP wiring (Inkrement 9) — needs Hermes-version
  research; without it CEO uses Python `requests` via skill
- Notification channels for ApprovalService (Inkrement 10) — Signal,
  Telegram, email; transports are pluggable into the existing service
- UI: company-status dashboard, approval inbox (Inkrement 11)
- Cron / scheduled tasks (`runner_type: scheduled`) — still parked
- Per-company catalog overrides

## Pre-flight checklist before starting

- [ ] `git pull origin feature/speckit-company-extension` (or push first)
- [ ] `docker image inspect hermes-agent:dev` — image still present
- [ ] `node --test tests/*.test.js tests/runners/*.test.js` — baseline
      regression check
- [ ] Confirm `~/.claude/.credentials.json` token still valid (expires ~6h
      after issue) OR have a real `ANTHROPIC_API_KEY` ready

## Estimated effort

3-4 focused hours. Risk: 8.4 (multi-agent E2E) might surface CEO-prompt-
engineering issues — when CEO can't be cleanly instructed to call the
dispatch endpoint, fall back to writing a small "smoketest worker"
that just receives a YAML and writes a file (no LLM-driven delegation
logic) until proper MCP wiring lands in Inkrement 9.
