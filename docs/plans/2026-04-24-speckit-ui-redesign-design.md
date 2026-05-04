# Specifyr Frontend Redesign — Design Document

**Date:** 2026-04-24
**Status:** Draft — in validation with user
**Scope:** Complete frontend overhaul of specifyr to operationally drive spec-kit

---

## 1. Scope, Goals & Non-Goals

### Goal
Replace the current cosmetic frontend with an operational UI that drives every phase of the [spec-kit](https://github.com/github/spec-kit) workflow end-to-end. The user creates a project, walks through five visible steps (`Constitution → Specify → Plan → Tasks → Implement`) via a chat-first interface, and watches Hermes execute tasks on a live run dashboard. Extensions are first-class: discoverable, installable, and able to inject commands and gates into the stepper.

### Design principles
- **Nothing ornamental.** Every widget reflects real project state or triggers a real backend action.
- **Spec-kit philosophy preserved.** Artifacts are explicit files under `projects/<slug>/.specify/`; progression is human-gated; upstream changes mark downstream artifacts stale, never delete them silently.
- **Extension-aware by design.** The step/command model accepts dynamic hooks (e.g. `red-team before_plan`) without hardcoding.
- **Backend stays.** The existing orchestrator, artifact store, and event store are fundament, not legacy to replace. The frontend, `SpecStudio.vue`, `WorkflowRail.vue`, `app/lib/spec-kit.ts` go.

### In scope
Frontend rewrite (Nuxt 4 + Vue 3 + shadcn-vue primitives kept). New API routes. New `ClaudeCodeRunner` for steps 1–4. Extension registry + install flow. Task dependency graph. Streaming run dashboard. Per-project Hermes memory isolation.

### Non-goals
No reimplementation of spec-kit logic — we orchestrate, not replace. No multi-user / auth. No cloud deployment. No real-time collaboration. No custom LLM; Claude Code CLI and Hermes CLI are dependencies. Git integration for artifact history is deferred.

---

## 2. Information Architecture & Navigation

### Route map

```
/                                     Project list (chat-history-style sidebar)
/extensions                           Global extension catalog (77+ entries)
/specs/[slug]                         Project dashboard (overview)
/specs/[slug]/steps/constitution      Per-step workspace (chat + sessions + artifact)
/specs/[slug]/steps/specify           "
/specs/[slug]/steps/plan              "
/specs/[slug]/steps/tasks             "
/specs/[slug]/run                     Live run dashboard (task graph + Hermes streaming)
```

Step 5 (**Implement**) has no `/steps/implement` route. Clicking it in the stepper navigates to `/specs/[slug]/run`, making the chat-vs-task-execution break visually explicit.

### Page responsibilities

- **`/`** — Vertical list of projects styled like Claude/ChatGPT chat history: title, last-activity timestamp, current stage badge, `+` button at top. Clicking a row enters the project dashboard. No cards, no marketing panels.
- **`/extensions`** — Grid of all extensions fetched from the community Next.js data endpoint. Search, tag filter, detail drawer on click. "Install" opens a modal to pick target projects and toggle "always install on new projects".
- **`/specs/[slug]`** — Project dashboard. Five widgets: (1) stepper with per-step status, (2) current activity (running session/run or "idle"), (3) implement snapshot (X/Y tasks, error count), (4) notification log (last 5 + "view all" drawer), (5) installed extensions with uninstall option.
- **`/specs/[slug]/steps/[stepId]`** — Three-pane layout: left = session list for this step (list of sessions + "new session" button), center = chat stream of the active session, right = live artifact viewer with power-mode toggle.
- **`/specs/[slug]/run`** — Task graph visualization (nodes = tasks, edges = dependencies), per-task expandable log panel with Hermes token streaming, global run controls (start, pause, retry-failed).

### Global layout

A persistent left sidebar lists all projects (same source as `/`) so the user can switch projects without leaving the current view. Top bar shows project title, current step crumb, and a global "notifications" bell that opens the per-project notification drawer.

---

## 3. Step Model, Sessions & Chat Mechanics

### Step concept

A **step** is a UI-level organizational unit that groups chat sessions and owns zero or more artifact files. The five steps are declared in config, not hardcoded per-page:

```ts
// app/lib/steps.ts
export const STEPS = [
  { id: "constitution", command: "/speckit.constitution", artifacts: [".specify/memory/constitution.md"] },
  { id: "specify",      command: "/speckit.specify",      artifacts: [".specify/specs/<feature>/spec.md"] },
  { id: "plan",         command: "/speckit.plan",         artifacts: [".specify/specs/<feature>/plan.md"] },
  { id: "tasks",        command: "/speckit.tasks",        artifacts: [".specify/specs/<feature>/tasks.md", "tasks.graph.json"] },
  { id: "implement",    command: "/speckit.implement",    isRun: true }
];
```

Extensions can augment this list at runtime via a registration mechanism (see §5).

### Session = one Claude Code conversation

A **session** is a single `claude --session-id <uuid>` invocation that can be resumed with `claude --resume <uuid>`. A step holds a list of sessions, each with its own message history. The user starts a new session by clicking "+ Neue Session" and types the first prompt (pre-filled with the step's primary slash command). Previous sessions remain read-only unless the user clicks "Fortsetzen", which issues `claude --resume`.

### Chat turn flow

1. User submits prompt → POST `/api/projects/[slug]/steps/[stepId]/sessions/[sessionId]/messages`
2. Server spawns `claude -p <prompt> --session-id <uuid> --output-format stream-json` in `projects/<slug>`
3. stdout JSON-lines are streamed to the UI via SSE
4. UI renders tokens progressively; when `result` event arrives, session status flips to `completed`
5. File-system watcher picks up any `.specify/**` writes → emits `artifact_updated` events → artifact panel hot-reloads

### Stepper state & invalidation

Each step carries a status: `untouched | in_progress | complete | stale`. When an artifact upstream of a downstream step changes, the downstream step transitions to `stale` with a banner showing which upstream change triggered it. No downstream data is deleted. Re-running the downstream step clears the stale flag. The stepper badges show status at a glance.

### Prefilled prompt templates & command palette

When the user opens a step and clicks "+ Neue Session", the input is prefilled with the step's primary command (`/speckit.specify `, etc.). A command palette below the input lists secondary commands applicable to this step (e.g. Specify offers `/speckit.clarify`; with extensions, also `/speckit.red-team.run`). Clicking a palette chip swaps the prefix.

---

## 4. Artifact Viewer & Power Mode

### Default: read-only rendered markdown

Every step's right pane renders its artifact files as rendered Markdown. File-system watcher updates the pane on change. Tabs switch between multiple artifacts (e.g. Plan step shows `plan.md` + the `constitution.md` it depends on, read-only reference).

### Power mode — selection-as-prompt

A toggle in the artifact pane header (`🔧 Direkt-Edit`) enables **Power Mode**. In this mode, text selection in the rendered view shows a floating action: "Ändere das zu...". Clicking it opens an inline prompt. Submitting injects a new user turn into the current session of the form:

> In the artifact `spec.md`, modify the following block:
>
> ```
> <selected text>
> ```
>
> Change: <user's instruction>

This routes all changes through Claude (maintains session history) rather than writing to disk directly, preserving the chat as single source of truth.

### Manual file edits

Users can still open the file in any external editor (e.g. VS Code). The watcher detects external changes and displays a banner: "External change detected, no session attributed". Those changes are not lost, but are marked as orphan edits in the event log.

---

## 5. Extension System

### Catalog source

A server-side helper (`server/utils/extension-catalog.ts`) fetches the community catalog's Next.js data endpoint dynamically:

1. `GET https://speckit-community.github.io/extensions/all-extensions` → extract `buildId` from `__NEXT_DATA__`
2. `GET https://speckit-community.github.io/extensions/_next/data/<buildId>/all-extensions.json` → parse JSON
3. Cache result at `server/data/extension-index.json` with 24h TTL
4. On fetch failure, fall back to last-good cache + 5-item hardcoded safety list (superpowers-bridge, red-team, verify, v-model-pack, docguard)

Each index entry already includes `name`, `id`, `description`, `author`, `version`, `tags`, `provides.commands`, `provides.hooks`, `repository`, `license`. Enough for the catalog page without scraping individual pages.

### Installation flow

Clicking **Install** on the catalog opens a modal:

- Multi-select of all existing projects
- Checkbox "Always install on newly created projects" (persisted in `.specifyr/config.json`)
- Checkbox "Apply to all existing projects"

On submit, the server runs `specify extension add <slug>` in each selected `projects/<slug>/` and records in `.specifyr/<slug>/extensions.json` which extensions are installed. If an extension is being auto-installed (via the global default), it's recorded with source `auto`.

### Default extensions

**`superpowers-bridge` is auto-installed on every new project** (opt-out at project-creation time via a checkbox). All other extensions are opt-in. Rationale: superpowers-bridge's phased-tasks output directly feeds our task graph (§6) and its brainstorm/review commands add broad value. Red-team remains opt-in because its adversarial gate is domain-specific.

### Extension-provided commands & hooks

When an extension is installed in a project, the server fetches its detail page once and stores `{commands: [...], hooks: [...]}` in `.specifyr/<slug>/extensions.json`. The step UI reads this to (a) add extension commands to the command palette contextually and (b) render hook-gates in the stepper.

Example: with `red-team` installed, Step `plan` shows a gate panel above the chat: "Red Team review required before plan can run" with a button to start the gate session. The gate runs `/speckit.red-team.run` and must reach `completed` status before `/speckit.plan` sessions can be submitted.

### Extension management per-project

The project dashboard's "Installed Extensions" widget lists active extensions with uninstall buttons. Uninstall runs `specify extension remove <slug>` and updates the JSON. No UI surprises: every action maps to a visible `specify` CLI call.

---

## 6. Implement Phase — Hermes, Task Graph, Run Dashboard

### Task graph extraction

After any `tasks.md` write, a post-processing pipeline produces `tasks.graph.json`:

```ts
interface TaskGraph {
  tasks: Array<{
    id: string;              // T01
    title: string;
    description: string;
    dependsOn: string[];     // [T01, T03]
    estimatedMinutes?: number;
    category?: string;
  }>;
  generatedFrom: "native" | "superpowers-bridge";
  generatedAt: string;
}
```

The extractor is adapter-based:

- If `superpowers-bridge` is installed and `tasks.md` contains its phase-marker syntax → **SuperpowersTaskFormatter** parses deterministically.
- Otherwise → **NativeTaskFormatter** makes a single Claude headless call with a fixed extraction prompt (a template under `server/prompts/extract-tasks.md`) to convert freeform markdown into the JSON schema.

The graph is invalidated whenever `tasks.md` mtime changes.

### Runner selection

Hermes is the **default** runner. Configuration in `.specifyr/config.json`:

```json
{
  "runner": "hermes",          // hermes | superpowers | claude
  "fallbackChain": ["hermes", "superpowers", "claude"]
}
```

On run-start, the selected runner is probed (binary present, subscription valid). If unavailable, fall back down the chain. The active runner for each task is recorded in the notification log.

### Hermes per-project memory isolation

Each project gets its own Hermes memory root: `projects/<slug>/.hermes/memory/`. The `HermesStreamingRunner` invokes `hermes chat --memory-root ./.hermes/memory` (exact flag verified at implementation time; if unsupported, we `HERMES_HOME`-env-scope per process). This means Hermes learns patterns per project without cross-project bleed-over. Global learning is explicit opt-in via a project config flag.

### Scheduling & parallelism

A topological sort of `tasks.graph.json` produces layers; tasks within a layer without shared dependencies run in parallel (bounded by `config.maxParallelTasks`, default 3). A task starts when all its `dependsOn` tasks reach `completed`. A task that fails marks its dependents `blocked_by_upstream`; the run continues with independent branches and pauses only if no runnable tasks remain.

### Error handling & notifications

Every task lifecycle event (`started`, `progress`, `completed`, `failed`, `blocked_by_upstream`, `retried`) emits a notification. On failure, the dashboard shows a red banner with:

- Task ID + title
- Last N lines of transcript
- Buttons: **Retry**, **Skip**, **Edit task** (opens tasks.md in power-mode), **Jump to upstream step** (if the failure looks spec-/plan-related)

### Run dashboard UI

- **Top:** global controls (Start/Pause/Stop, runner selector, parallelism slider)
- **Left:** task graph visualization (nodes colored by status, edges by dependency); clickable
- **Right:** selected task panel with full transcript, token stream, outputs, runtime, retry history
- **Bottom:** notification timeline, filterable by level

---

## 7. Persistence Layer & Data Model

### Directory layout

```
projects/
  <slug>/                              ← project working directory (specify init creates this)
    .specify/                          ← spec-kit's own directory
      memory/constitution.md
      specs/<feature>/{spec,plan,tasks}.md
      templates/
    .hermes/memory/                    ← per-project Hermes memory
    src/ ...                           ← whatever the project actually builds

.specifyr/
  config.json                          ← global config (runner default, auto-install extensions)
  <slug>/
    project.json                       ← slug, title, description, createdAt
    run.json                           ← current stage, completed/failed task ids, approvals
    events.jsonl                       ← append-only notification log
    extensions.json                    ← installed extensions with commands/hooks
    tasks.graph.json                   ← generated dependency graph
    hermes-history.json                ← our-side track record of Hermes runs
    steps/
      <stepId>.json                    ← step status (untouched|in_progress|complete|stale), stale-since
      <stepId>/
        sessions/
          <uuid>.json                  ← session metadata
          <uuid>.messages.jsonl        ← append-only message stream
    artifacts/
      history/
        spec.md.2026-04-24T101530.md   ← snapshot on every write
        plan.md.2026-04-24T110045.md
```

### Why this layout

- **Git-friendly.** All state is plain files. Users can version-control `.specifyr/` alongside their project if desired.
- **Inspectable.** Same philosophy as spec-kit itself.
- **Append-only where possible.** JSONL for messages and events means easy recovery and no corruption on crash.
- **Matches existing store.** `src/core/artifact-store.js` and `src/core/event-store.js` already work on flat files under `.specifyr/`; we extend, not replace.

### Watcher layer

A `chokidar` watcher in the Nuxt server monitors `projects/<slug>/.specify/**` per open project. On change, it emits an SSE event that the UI subscribes to, keeping artifact panels hot. The watcher debounces by 200ms to avoid storm during multi-file writes.

---

## 8. Backend API & Streaming

### REST endpoints

```
GET    /api/projects                                            list
POST   /api/projects                                            create (runs specify init)
GET    /api/projects/:slug                                      project snapshot (dashboard data)
DELETE /api/projects/:slug                                      remove project (confirmation required)

GET    /api/projects/:slug/steps                                all step statuses
GET    /api/projects/:slug/steps/:stepId                        step detail (sessions list + artifacts)

POST   /api/projects/:slug/steps/:stepId/sessions               create new session
GET    /api/projects/:slug/steps/:stepId/sessions/:sid          session detail + message history
POST   /api/projects/:slug/steps/:stepId/sessions/:sid/messages submit new turn (returns stream URL)
POST   /api/projects/:slug/steps/:stepId/sessions/:sid/resume   resume session (Claude --resume)

GET    /api/projects/:slug/artifacts/:path                      raw artifact (for viewer)
GET    /api/projects/:slug/events                               paginated event log

POST   /api/projects/:slug/run/start                            begin implement phase
POST   /api/projects/:slug/run/pause                            pause run
POST   /api/projects/:slug/run/tasks/:tid/retry                 retry a failed task
GET    /api/projects/:slug/run/graph                            tasks.graph.json

GET    /api/extensions                                          catalog (cached)
POST   /api/extensions/:slug/install                            body: { projects: [...], alwaysInstall: bool }
POST   /api/extensions/:slug/uninstall                          body: { projects: [...] }
```

### Streaming endpoints (SSE)

```
GET /api/projects/:slug/steps/:stepId/sessions/:sid/stream      live Claude token stream
GET /api/projects/:slug/run/stream                              live run events (task lifecycle + hermes tokens)
GET /api/projects/:slug/stream                                  global project event stream (for dashboard hot-reload)
```

All SSE streams use server-sent-event format with JSON payloads matching the event-store schema.

### Runner abstraction

Two new runner classes, both extending a `StreamingRunner` base:

```ts
abstract class StreamingRunner extends EventEmitter {
  abstract start(input: RunnerInput): AsyncIterable<RunnerEvent>;
  abstract cancel(): void;
}

class ClaudeCodeRunner extends StreamingRunner { ... }    // steps 1–4
class HermesStreamingRunner extends StreamingRunner { ... } // step 5 (replaces current hermes-cli.js)
```

`ClaudeCodeRunner` spawns `claude -p --output-format stream-json`, parses JSONL stdout, emits typed events. `HermesStreamingRunner` uses `child_process.spawn` on the hermes binary with `--memory-root` per project.

---

## 9. Component & Code Inventory

### Removed (frontend)

- `app/components/SpecStudio.vue` — 644 lines of simulated chat + cosmetic tour
- `app/components/WorkflowRail.vue` — static 4-card workflow display
- `app/components/ArtifactTabs.vue` — replaced by new `ArtifactViewer.vue`
- `app/components/RunSummary.vue` — replaced by dashboard widgets
- `app/components/TimelinePanel.vue` — replaced by `NotificationDrawer.vue`
- `app/components/ProjectSidebar.vue` — replaced by `ProjectListSidebar.vue` with chat-history styling
- `app/lib/spec-kit.ts` — cheat-sheet data, tour steps; obsolete

### New (frontend)

```
app/components/
  ProjectListSidebar.vue              chat-history-style project list
  ProjectCreateDialog.vue             "+ New project" modal
  Stepper.vue                         5-step stepper with status & stale badges
  StepWorkspace.vue                   three-pane (sessions | chat | artifact)
  SessionList.vue                     left pane of step workspace
  ChatStream.vue                      middle pane, token-streaming
  CommandPalette.vue                  prefilled-prompt chips under input
  ArtifactViewer.vue                  right pane, read-only + power mode
  PowerModeSelection.vue              floating selection-prompt action
  NotificationLogWidget.vue           dashboard "last 5" component
  NotificationDrawer.vue              full filtered log
  ExtensionCatalog.vue                /extensions grid
  ExtensionInstallDialog.vue          project-select + always-install modal
  RunDashboard.vue                    top-level /run layout
  TaskGraph.vue                       graph visualization
  TaskDetailPanel.vue                 right pane for selected task
  HookGateBanner.vue                  extension-gate block in step workspace

app/lib/
  steps.ts                            step registry
  sse-client.ts                       typed SSE helper
  types.ts                            shared types (Session, Step, Task, Event, etc.)
```

### Kept (frontend)

- `app/components/ui/` — shadcn-vue primitives (Badge, Button, Card, ...)
- `app/assets/` — Tailwind config and styles
- `nuxt.config.ts`, `tsconfig.json`, `package.json` — adjusted, not replaced

### Backend changes

- **Keep:** `src/core/artifact-store.js`, `src/core/event-store.js`, `src/core/orchestrator.js`, `src/core/config.js`, `src/core/constants.js`, `src/core/spec-kit-bridge.js`, `src/utils/**`
- **Extend:** `src/runners/` — `hermes-cli.js` becomes `HermesStreamingRunner`; add `claude-code.js` for `ClaudeCodeRunner`
- **New files:**
  - `src/core/session-store.js` — CRUD for sessions + messages
  - `src/core/step-state.js` — step status machine with stale propagation
  - `src/core/task-graph.js` — adapter-based tasks.md → graph.json
  - `src/core/run-scheduler.js` — topological scheduler with parallelism
  - `src/core/extension-registry.js` — catalog fetch + install orchestration
  - `server/utils/extension-catalog.ts` — Next.js data endpoint client
  - `server/utils/file-watcher.ts` — chokidar-based artifact watcher

---

## 10. Build Order & Risks

### Suggested build order

1. **Foundation** (no user-visible change):
   - `session-store.js`, `step-state.js`, `task-graph.js`, `run-scheduler.js`
   - Extend `event-store` schema with new event types
2. **New runners:**
   - `ClaudeCodeRunner` with SSE streaming endpoint
   - Refactor `HermesStreamingRunner` from existing `hermes-cli.js`
3. **Frontend shell:**
   - Route scaffolding, layout, sidebar
   - Delete old `SpecStudio.vue`, `WorkflowRail.vue`, ...
4. **Step workspace** (core UX):
   - `StepWorkspace.vue`, `SessionList.vue`, `ChatStream.vue`, `ArtifactViewer.vue`
   - Power-mode selection-as-prompt
5. **Project dashboard:**
   - Widgets, stepper, notification log
6. **Extensions:**
   - Catalog fetch, `/extensions` page, install dialog
   - Extension-aware command palette + hook-gate banners
7. **Run dashboard:**
   - Task graph viz, task detail panel, streaming
   - Retry / skip / jump-to-upstream flows
8. **Polish:**
   - File watcher integration (hot-reload)
   - External-edit detection
   - Error recovery flows

### Known risks

- **Claude Code stream-json schema** is stable but versioned — pin expectations on a version range and add a schema-version guard in `ClaudeCodeRunner`.
- **Hermes memory flag** — the exact CLI flag (`--memory-root`, `HERMES_HOME`, or something else) has to be verified against the installed binary at implementation time. Fallback: process-scoped `HOME` override.
- **Community catalog build-id rotation** — our buildId extraction from `__NEXT_DATA__` is the stable path; a fallback hardcoded list of ~5 popular extensions is the last-resort.
- **Task graph LLM extraction** — for native spec-kit (without superpowers-bridge), the extraction prompt quality determines dependency accuracy. Needs test cases with real-world tasks.md samples during build.
- **Spec-kit CLI contract drift** — if `specify init` or `specify extension add` ever change output/flags, the wrappers in `server/utils/project-creation.ts` and `extension-registry.js` break. Mitigation: integration tests per CLI command.

### Deferred

- Git integration for artifact version history (today: timestamped copies in `.specifyr/<slug>/artifacts/history/`)
- Multi-user / auth
- Global notifications across all projects (only per-project in v1)
- Manual drag/drop reordering of tasks
- Custom extension development (only install, no local dev)
- Markdown editor for power mode (today: selection-to-prompt only)

---

## Appendix A — Open questions for implementation phase

These intentionally do not block design validation but will surface when coding:

1. Exact Claude Code stream-json event set we care about (tool use visualization — do we show `Read`/`Write` tool invocations in the chat, or hide them?)
2. How Hermes reports token-level progress (does it emit structured events, or only final stdout?)
3. Whether `specify extension add` supports non-interactive installation (no prompts) — if not, we need PTY wrapping.
4. File-watcher scope — watch entire `.specify/` or only the files tied to currently-viewed artifact?
5. Session titles — user-provided on create, auto-generated from first turn, or derived from the command?

