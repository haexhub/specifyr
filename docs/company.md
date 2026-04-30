# Company runtime — multi-agent orchestration

The company runtime extends speculoss into a spec-driven multi-agent system. The user declares a "company" once (CEO + workers, hierarchy, capabilities, budget) and then drops tasks into a queue for the company to execute autonomously.

This document describes the **runtime side** living in speculoss. The user-facing slash commands (`/speckit.company.init`, `/speckit.company.hire`, …) and templates live in the separate [speckit-company](https://github.com/haex/speckit-company) extension repo.

## Architecture

```
                ┌───────────────────────────────────┐
                │  User                             │
                │  (drops task in queue, talks to   │
                │   CEO via /speckit.company.* CLI) │
                └─────────────┬─────────────────────┘
                              │
                              ▼
              .specops/<company>/queue/<task>.yaml
                              │
                              ▼
              ┌─────────────────────────────┐
              │ QueuePoller (chokidar)      │
              │ src/core/queue-poller.js    │
              └─────────────┬───────────────┘
                            │ task event
                            ▼
              ┌─────────────────────────────────────┐
              │ CompanyRuntime                      │
              │ src/core/company-runtime.js         │
              │  - loads .specify/org/              │
              │  - starts CEO (persistent Hermes)   │
              │  - spawns workers (ephemeral Hermes)│
              └─────────────┬───────────────────────┘
                            │
                            │ MCP (company-ops)
                            ▼
              ┌─────────────────────────────┐
              │ Worker agents (Hermes)      │
              │ <project>/.hermes/<role>/   │ ← per-agent profile + memory
              └─────────────────────────────┘
```

## Per-agent Hermes profiles

[Hermes Agent](https://hermes-agent.nousresearch.com/) supports profiles via the `HERMES_HOME` environment variable — every concrete `HERMES_HOME` directory holds independent config, memory, sessions, and skills. The runtime exploits this by setting `HERMES_HOME=<project>/.hermes/<role>/` per agent.

Result: the CEO accumulates skills around triage and dispatch; the Frontend-Dev around UI work; the QA agent around test design. Self-improvement is automatic — Hermes curates its own memory.

The path computation is centralised in `src/runners/hermes-paths.js` (`hermesHomeForAgent({projectRoot, role})`), used both by `HermesCliRunner` and by `CompanyRuntime` when provisioning profile dirs at start.

## Capability gate

`src/core/capability-gate.js` enforces a default-deny permission model. Each agent's `capabilities` list (from `.specify/org/agents/<role>.md` frontmatter) is the only authority — anything not granted is forbidden. A few grants are flagged as **sensitive** and trigger user-approval at every use, regardless of task autonomy:

- `payment:execute_unrestricted`
- `secrets:read_vault`
- any `account:*`

The gate is a pure function: `checkCapability({agent, request, taskAutonomy})` returns `{allowed, reason, requiresApproval}`. The runtime is expected to invoke `ApprovalService` whenever `requiresApproval=true`.

## Worktree isolation

Tasks that mutate the filesystem (`mutates_filesystem: true` in the task spec, default) get a per-task `git worktree` under `<repo>/.worktrees/<task-slug>/` with a dedicated branch `company/<task-slug>`. This lets multiple feature-development tasks run in parallel without interference.

Tasks with `isolation: shared` (research, monitoring, trading) skip the worktree.

`src/core/worktree-manager.js` wraps `git worktree add/remove` with strict slug validation (no path traversal).

## Queue lifecycle

```
.specops/<company>/queue/<task-slug>.yaml   ← user drops here

      ↓ chokidar 'add' event

CompanyRuntime emits 'task' event
  (consumer: CEO process via company-ops MCP)

      ↓ CEO triages → dispatch_to_agent(role, sub_task)

Sub-task lifecycle managed via existing speculoss stages:
  draft → triaged_by_ceo → dispatched → in_progress → result_returned
        → ceo_review → (next_dispatch | completed | escalated_to_user)
```

Continuous-mode companies emit synthetic reporting tasks on a cron driven by `reporting_cadence` in the constitution — the queue itself stays the single dispatch funnel.

## company-ops MCP server

Lives in the `speckit-company` repo (`mcp-server/company-ops/`). The CEO connects to it via Hermes' MCP integration and uses these tools:

- `dispatch_to_agent(role, task)` — route a sub-task to a specific worker
- `read_artifact(path)` — pull another agent's output file
- `ask_user(question, options?)` — pause and ask the user (only when task autonomy permits)
- `escalate(reason)` — halt with user-approval request (used for sensitive capabilities or when stuck)
- `query_org_chart()` — introspect the live org

When `COMPANY_OPS_BASE_URL` is set, company-ops POSTs back to this speculoss instance via:

- `POST /api/projects/<slug>/company/dispatch`
- `POST /api/projects/<slug>/company/ask-user`
- `POST /api/projects/<slug>/company/escalate`
- `GET /api/projects/<slug>/company/agents`
- `GET /api/projects/<slug>/company/artifact?path=...`

These endpoints are not implemented yet (Inkrement 4 work). For development, company-ops falls back to in-process stubs when the env vars are unset.

## Status — what's done, what's next

✅ **Done in this branch:**
- Spec-loader, capability-gate, queue-poller, worktree-manager, company-runtime
- Hermes per-agent profile path helper
- HermesCliRunner patched to pass `HERMES_HOME`
- 47 tests green (incl. existing orchestrator tests)

🚧 **Outstanding (future increments):**
- Server API endpoints listed above (currently the URL contract is documented but the Nuxt routes aren't written)
- Wiring `CompanyRuntime` into the existing UI / `run start` CLI flow
- Cron-trigger for `runner_type: scheduled` agents in continuous-mode
- ApprovalService integration with capability-gate for sensitive grants

## Related code

- [src/agents/spec-loader.js](../src/agents/spec-loader.js)
- [src/core/capability-gate.js](../src/core/capability-gate.js)
- [src/core/queue-poller.js](../src/core/queue-poller.js)
- [src/core/worktree-manager.js](../src/core/worktree-manager.js)
- [src/core/company-runtime.js](../src/core/company-runtime.js)
- [src/runners/hermes-paths.js](../src/runners/hermes-paths.js)
- [src/runners/hermes-cli.js](../src/runners/hermes-cli.js) (patched)
