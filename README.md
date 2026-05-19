# specifyr

specifyr is a local, spec-driven orchestration tool for building software through explicit artifacts instead of opaque agent prompts. The intended workflow is:

1. Formulate the work clearly in `spec-kit`.
2. Sync the finalized spec into specifyr.
3. Let specifyr generate the plan and work items.
4. Let `hermes-agent` execute the approved work.
5. Use `fabric` only where critique, summaries, or refinement patterns are useful.

Each initiative lives under `.specifyr/<slug>/` and moves through visible stages: `draft`, `refined`, `planned`, `approved_for_execution`, `running`, `blocked`, `completed`, `failed`.

## What is included

- A repo-native artifact store for specs, plans, tasks, run state, and event logs
- A central orchestrator with approval gates
- Provider and runner interfaces with local adapters for model generation and Hermes-style agent execution
- Optional CLI adapters for `fabric` and `hermes` with safe fallback to local implementations
- A `.specify/` mirror for spec-kit-style artifact navigation
- Fabric-inspired pattern resolution by workflow stage
- A Nuxt 4 UI built with Vue, Tailwind, and shadcn-style components for timeline, artifact, and run inspection

## CLI

```bash
node ./src/index.js init
node ./src/index.js config show
node ./src/index.js config set integrations.fabric.enabled true
node ./src/index.js config set integrations.hermes.enabled true
node ./src/index.js spec create "Build a transparent spec-driven orchestrator"
node ./src/index.js spec sync my-spec
node ./src/index.js spec refine my-spec
node ./src/index.js plan generate my-spec
node ./src/index.js tasks generate my-spec
node ./src/index.js approve my-spec spec
node ./src/index.js approve my-spec plan
node ./src/index.js approve my-spec task_batch
node ./src/index.js run start my-spec
node ./src/index.js run status my-spec
node ./src/index.js ui
```

## Notes

- Artifacts are plain files under `.specifyr/`.
- Specs can be authored in `.specify/specs/<slug>/spec.md` and pulled into specifyr with `spec sync <slug>`.
- specifyr also mirrors every initiative back into `.specify/specs/<slug>/` so the workflow stays compatible with spec-kit-style navigation.
- Speckit workflow runs use an explicit ACP-backed agent profile from Settings: runner, provider, model, and credential.
- No host CLI credential directory is mounted by default; local and cloud runs use the same Settings-managed auth path.
- The UI runs through Nuxt. For local development use `pnpm dev` or `node ./src/index.js ui`.

## Development with Docker

For containerized development with hot module replacement:

```bash
# Start dev environment with source mounting
./dev.sh
# or
pnpm run dev:docker

# Useful commands:
docker compose logs -f          # View logs
docker compose exec specifyr sh # Shell access
docker compose down             # Stop containers
```

The dev compose bundles two parallel access paths:

- **`http://localhost:10000`** — specifyr direct, bypassing auth. The
  `SPECIFYR_DEV_USER_EMAIL` env-fallback is the "logged-in user" here, so
  this is the fastest path for code iteration. Port = `SPECIFYR_PORT`
  (default `PORT_BASE`=10000); see `.env.example` for the full scheme.
- **`http://specifyr.localhost`** — full multi-user flow through Traefik
  → Authentik (UI on `http://auth.localhost`, default login
  `akadmin` / `akadmin-dev`). Use this to exercise the prod-shape auth
  topology (forward-auth headers, per-user `users` rows, onboarding gate).
  Set `SPECIFYR_DEV_USER_EMAIL=` empty in `.env` so the env-fallback does
  not override the real Authentik headers.

## ACP (Agent Client Protocol)

specifyr speaks the [Agent Client Protocol](https://agentclientprotocol.com) in two directions:

- **As a client** (input): any ACP-speaking coding agent (Codex, Claude, Gemini, … via ACP adapters) can be a backend. Configure Speckit agent selection in Settings and the matching `acp.<name>` binary/args in [src/core/app-config.js](src/core/app-config.js) or `.specifyr/config.json`.
- **As a server** (output): `bin/specifyr-acp` is a stdio agent that external editors like Zed and AionUi can spawn to drive specifyr runs. See [docs/acp-integration.md](docs/acp-integration.md).

Internally specifyr uses ACP `SessionUpdate` shapes as the lingua franca for all runner output, persisted disk events, and SSE stream payloads.

## Company runtime (multi-agent)

The company runtime turns specifyr into a multi-agent orchestrator. A "company" is declared via the [speckit-company](https://github.com/haex/speckit-company) extension and consists of a CEO agent (single point of contact) and worker agents in a reports-to graph. Each agent is a separate Hermes-Agent profile with its own `HERMES_HOME`, accumulating role-specific skills over time.

Components (in `src/`):

- `agents/spec-loader.js` — load `.specify/org/{constitution.md, agents/<role>.md}`
- `core/capability-gate.js` — default-deny permission layer; sensitive grants always require user approval
- `core/queue-poller.js` — chokidar watcher for `.specifyr/<company>/queue/<task>.yaml`
- `core/worktree-manager.js` — per-task `git worktree` for isolated FS mutations
- `core/company-runtime.js` — facade composing the above + per-agent runner factory (typically `HermesStreamingRunner` or a Docker-isolated runner)
- `runners/hermes-paths.js` — deterministic `<project>/.hermes/<role>` path
- `runners/hermes-streaming.js` — streams `hermes chat -q` stdout, translates to ACP SessionUpdate, passes `HERMES_HOME` via env per agent

See [docs/company.md](docs/company.md) for the full integration model.
