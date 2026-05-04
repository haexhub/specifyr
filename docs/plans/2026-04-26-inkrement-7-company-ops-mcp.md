# Inkrement 7 — company-ops MCP server

## Context

After Inkrement 6 + 6.7, the in-process plumbing is complete: tasks
dispatch to the CEO container, the runtime owns a CapabilityApprovalService,
and `authorizeWithApproval()` blocks on user decisions when sensitive
capabilities are flagged. **What's still missing is the channel by which
worker containers actually reach those services.** Today they run in
isolated hermes-agent containers with no callback path back to specifyr.

This inkrement closes that gap: a `company-ops` MCP server exposed by
specifyr that workers connect to from inside their containers.

## Open issues this addresses

1. Catalog references `tools.mcp: [company-ops]` but no server exists
2. `authorizeWithApproval()` and `requestApproval()` have no caller from
   the agent side — workers cannot trigger an approval flow
3. CEO has no way to dispatch sub-tasks to workers (would also flow
   through the MCP server)

## Goal & Non-Goals

### In scope
- A minimal HTTP-based MCP server inside specifyr (Nuxt route or Nitro
  plugin) that exposes:
  - `authorize` — wraps `runtime.authorizeWithApproval(...)`
  - `getAgent` — read-only spec lookup for `getResolvedTools/Skills/Binaries`
  - `dispatchTask` — CEO drops a sub-task into a worker queue
- Container reachability: workers join the `companies` network and call
  `http://specifyr:3000/mcp/<slug>/...`
- Per-slug routing — the URL path scopes all calls to one company runtime
- Auth: a per-runtime bearer token generated at `start()` and injected
  into worker containers via `secretsResolver` as `COMPANY_OPS_TOKEN`
- Hermes catalog wiring: update `catalog/tools/company-ops.yml` to
  point at the HTTP transport

### Out of scope
- Full MCP-stdio support (workers would need a sidecar; HTTP/SSE is
  simpler and matches the docker-network architecture)
- Multi-tenant or cross-slug calls (per-slug isolation is the security
  boundary)
- Workflow orchestration beyond simple dispatch — CEO logic stays its
  own concern

## Design decisions to make

### 1. MCP transport: HTTP/SSE vs. stdio

**HTTP/SSE** — single specifyr endpoint, all workers in the network
hit it. Auth via bearer token. Simple to debug (curl works).
Recommended.

**stdio with sidecar** — a per-container stdio bridge that proxies to
specifyr. Matches "official" MCP shape but adds a sidecar process per
agent. Higher infrastructure cost, no observable benefit for this
single-orchestrator setup.

### 2. Auth: bearer token vs. mTLS vs. none

For solo-dev / single-host deploys: per-runtime bearer token is enough.
Generated at `start()`, injected via `secretsResolver` so the worker
container reads it from env. The token is valid for the runtime's
lifetime; rotation = `stop` + `start`.

mTLS is overkill for the threat model (the `companies` network is
already isolated; the only attacker would already have host-root via
the docker socket).

### 3. dispatchTask routing

The CEO calls `dispatchTask({worker: "dev", task: {...}})`. Two options:

**(a) Drop YAML in `<projectRoot>/.specifyr/<slug>/queue-<role>/`** — a
  per-role queue dir picked up by per-role QueuePoller instances.
  Reuses the dispatch loop we just built.

**(b) In-process bypass: directly call `runner.execute()` for the
  worker** — skips the queue, slightly faster but couples MCP server
  to runner internals.

(a) is preferred: keeps the queue as the single source of truth; the
loops stay symmetric (CEO queue and worker queue both file-watched).

## Implementation Plan

### 7.1 — Per-runtime token + secretsResolver injection
- Generate `COMPANY_OPS_TOKEN` in CompanyRuntime.start()
- Expose via `runtime.opsToken`
- start.post.ts wraps the existing secretsResolver to also inject
  `COMPANY_OPS_TOKEN` and `COMPANY_OPS_URL=http://specifyr:3000/mcp/<slug>`

### 7.2 — Nuxt route(s)
- `server/api/mcp/[slug]/authorize.post.ts` — POST {role, capability,
  payload, taskAutonomy} → returns `runtime.authorizeWithApproval()`
- `server/api/mcp/[slug]/agents.get.ts` — list agents w/ resolved
  tools/skills/binaries
- `server/api/mcp/[slug]/dispatch.post.ts` — POST {worker, task} →
  writes YAML into per-role queue dir
- All routes assert `Authorization: Bearer <opsToken>` matches the
  active runtime; 401 otherwise. 404 when slug has no active runtime.

### 7.3 — Per-role queue dirs + dispatch loop
- Convert single QueuePoller into a Map<role, QueuePoller>
- Per role: `<projectRoot>/.specifyr/<slug>/queue-<role>/`
- CEO queue stays at `queue/` (or rename to `queue-ceo/` for symmetry —
  decide and migrate)
- Each role's poller calls `runners.get(role).execute(...)` on its
  events. `_dispatchToCEO` generalises to `_dispatchToRole(role, evt)`

### 7.4 — Catalog wiring
- Update `catalog/tools/company-ops.yml` to reflect HTTP transport:
  ```yaml
  type: mcp
  transport: http
  url_env: COMPANY_OPS_URL
  auth_env: COMPANY_OPS_TOKEN
  ```
- Hermes likely needs a small wrapper script or built-in HTTP-MCP
  client config — verify against current Hermes Agent 0.11.0 docs.

### 7.5 — Integration test
- Spin up a CompanyRuntime + the MCP routes
- From a test client (no actual hermes container), POST authorize for a
  sensitive cap → assert ApprovalService.requestApproval was called
- POST dispatch with worker=dev → assert YAML appears in queue-dev/
- POST without bearer → 401
- POST with stale token after stop+start → 401

## Verification

```bash
# 7.1 — token generation
node -e "const {CompanyRuntime} = await import('./src/core/company-runtime.js'); ..."

# 7.2 — endpoints
curl -sf -H "Authorization: Bearer $TOKEN" http://localhost:3000/mcp/test/agents
curl -sf -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"role":"ceo","capability":"filesystem:read"}' \
  http://localhost:3000/mcp/test/authorize

# 7.5
node --test tests/integration/mcp-server.test.js
```

## Critical files reference (planned)
- `src/core/company-runtime.js` — token generation, multi-queue dispatch
- `src/core/queue-poller.js` — already extends; possibly add per-poller
  metadata so the runtime knows which role each queue belongs to
- `server/api/mcp/[slug]/*.ts` — new route surface
- `server/utils/company-manager.ts` — registry already keyed by slug;
  bearer-token lookup added here

## Out of Inkrement-7 (defer further)
- Real notification transports (Signal/Telegram/email) for the approval
  service — channel implementations land separately
- Cross-runtime broker (multiple companies talking to each other)
- Worker-to-worker direct dispatch (everything routes via CEO for now)
- UI for approval interactions (current path: timeout-based deny)
