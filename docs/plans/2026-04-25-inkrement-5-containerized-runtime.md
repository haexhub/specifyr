# Inkrement 5 — Containerized runtime (per-agent Docker containers)

## Context

After Inkrement 4 finished the catalog/capability model, the user clarified that the runtime should be **fully containerized**: not just haex-corp itself (already in a Docker image), but every Hermes agent process. This shifts the runtime architecture meaningfully and replaces the previously-discussed Bash-wrapper approach to capability enforcement.

Quote: *"ich will hermes eigentlich nicht lokal installieren. alles sollte im docker container laufen. die gesamte anwendung"*.

## Goal & Non-Goals

### In Scope
- A new `hermes-docker.js` runner in haex-corp that spawns each agent in its own Docker container.
- A `Dockerfile.hermes-agent` (or multi-stage extension of the existing Dockerfile) producing an image with the Hermes CLI, Node 22, and a configurable allowlist of binaries.
- Capability→Docker-flag mapping: filesystem caps become bind-mount modes, network caps become `--network` modes, the binary whitelist becomes the set installed in the image (or PATH-restricted via entrypoint).
- Networking topology so each agent's `company-ops` MCP server can reach haex-corp's HTTP API by service name.
- The existing host-spawn `hermes-cli.js` stays as a development-only fallback.
- Smoke test: a trivial company runs end-to-end with a real Hermes agent in a container.

### Out of Scope (vorerst)
- Kubernetes / cloud deployment (single-host Docker Compose only).
- GPU support for local LLMs.
- Per-agent CPU/memory quotas (can be added later via `--cpus` / `--memory`).
- Replacing `claude-code` runner with a containerized version — only Hermes for now.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Host                                                         │
│  ┌──────────────────┐                                        │
│  │ Docker socket    │ ←─────────── mount ────┐               │
│  │ /var/run/docker.sock                       │               │
│  └──────────────────┘                         │               │
│                                               ▼               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ haex-corp (Nuxt + orchestrator + CompanyRuntime)        │  │
│  │  - reads agent specs                                    │  │
│  │  - resolves catalog references                          │  │
│  │  - calls hermes-docker runner per task dispatch         │  │
│  │  - exposes /api/projects/<slug>/company/* endpoints     │  │
│  └────────────────────────────────────────────────────────┘  │
│                          │ docker run                         │
│                          ▼                                    │
│  ┌────────────────────────┐  ┌────────────────────────┐      │
│  │ hermes-agent[ceo]      │  │ hermes-agent[dev]      │      │
│  │ HERMES_HOME=/profile   │  │ HERMES_HOME=/profile   │      │
│  │ binaries per whitelist │  │ binaries per whitelist │      │
│  │ MCP→company-ops→haex   │  │ MCP→company-ops→haex   │      │
│  └────────────────────────┘  └────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

### Capability → container constraint mapping

| Agent capability | Container constraint |
|---|---|
| `shell:execute` | container has bash + utility binaries (always true) |
| `filesystem:read` | `-v <project>:/workspace:ro` |
| `filesystem:write` | `-v <project>:/workspace:rw` |
| (no filesystem cap) | no bind mount of project; only HERMES_HOME volume |
| `network:http` | default bridge network |
| `network:any` | bridge + raw socket / no firewall |
| (no network cap) | `--network=none` |
| `secrets:read_env` | env vars selectively passed (`-e API_TOKEN=…`) |
| `tools.binaries: [git, jq]` | image includes only the listed binaries (or PATH is restricted via entrypoint to a whitelist) |
| `payment:execute_unrestricted` (sensitive) | container additionally has the configured payment provider's binary/credentials, **and** every operation triggers haex-corp ApprovalService gate via `company-ops` |

### Image strategy

Two practical options:

1. **Single fat image with all catalog binaries**, agent's binary whitelist enforced at runtime via PATH-restricted entrypoint.
   - Pro: one image to maintain
   - Con: ⊥ minimum-required principle; image is large

2. **Per-binary-set image variants** built on demand or pre-built.
   - Pro: smallest possible images per agent
   - Con: build pipeline complexity, image proliferation

Recommend (1) for v0.1 with `--read-only` rootfs + `--cap-drop=all` baseline. Image bloat is acceptable; security is preserved by capability-flag-mapping at `docker run`-time.

## Implementation Plan

### 5.1 — Hermes image

`Dockerfile.hermes-agent` extending Alpine/Debian:
- Install Hermes via the official `install.sh` (`curl … | bash`)
- Install all binaries from `catalog/binaries/*.yml` via `apk add` / `apt-get install` / direct downloads
- Pre-create `/profile` directory (mount point for HERMES_HOME)
- ENTRYPOINT: a small shell script that
  1. Reads `BINARY_WHITELIST` env, sanitises PATH to only contain those binaries
  2. Execs `hermes chat -q` with stdin/stdout passthrough

### 5.2 — `hermes-docker.js` runner

New file `src/runners/hermes-docker.js` implementing the same interface as `hermes-cli.js`. Differences:
- Constructor accepts `{ image, agentSpec, projectRoot, capabilities, binaryWhitelist }`
- `execute(workItem, runtimeContext)` builds `docker run` args from capabilities → flags, sets `HERMES_HOME=/profile` and bind-mounts a per-agent volume from `<projectRoot>/.hermes/<role>/`
- Streams stdout via `child_process.spawn`, parses output
- Network: attaches to a Compose-defined network where haex-corp is reachable as `haex-corp:3000`
- `capability-gate`-aware: refuses `--privileged`, refuses to mount `/`

### 5.3 — Compose updates

`docker-compose.yml` gets a second service for the agent network:
- `haex-corp` service (existing) needs `/var/run/docker.sock` mounted with read-only-by-default
- New named network `companies` that haex-corp and agent containers join
- `${HOME}/.claude` bind mount continues for orchestrator-side claude-code calls (not for agents)

### 5.4 — Capability→flag mapping module

`src/runners/capability-to-docker.js`:
- Pure function `capabilityFlags(agent, projectRoot) → string[]` returns `docker run` args
- Tested in isolation (no actual Docker invocation)

### 5.5 — Smoke test

`tests/integration/docker-runner-smoke.test.js`:
- Skipped if Docker not available
- Spins up the hermes-agent image, runs a trivial echo task, asserts result artifact exists
- Skipped in CI for now (assumes local Docker)

### 5.6 — Server-API endpoints

The `POST /api/projects/<slug>/company/start` endpoint instantiates `CompanyRuntime` with `runnerFactory: dockerRunnerFactory` instead of the default. This is now the natural integration point that was deferred from Inkrement 4.

## Open Questions

1. **PATH restriction inside the agent container**: viable via entrypoint script, or do we need a more solid mechanism (e.g. unionfs, or installing only the whitelisted binaries into a per-container layer at spawn time)?
2. **Resource limits**: `--cpus` and `--memory` per agent, where do defaults come from? Constitution? Per-agent override?
3. **Image build pipeline**: do we ship pre-built images on Docker Hub, or expect users to `docker build` locally?
4. **Hermes-Memory persistence across container restarts**: bind mount `<projectRoot>/.hermes/<role>/` is the answer — but what if the host filesystem is on a remote NFS that doesn't support the underlying syscalls?
5. **Approval gate UX**: when sensitive capabilities trigger `requiresApproval`, the approval flows through haex-corp's UI. The agent container blocks waiting on company-ops MCP response. Need a timeout / fallback.

## Verification

```bash
# 5.1
docker build -f Dockerfile.hermes-agent -t hermes-agent:dev .
docker run --rm -e HERMES_HOME=/profile -e BINARY_WHITELIST="git,jq" hermes-agent:dev hermes --version

# 5.2
node --test tests/runners/hermes-docker.test.js

# 5.4
node --test tests/runners/capability-to-docker.test.js

# 5.5
docker compose up haex-corp -d
node tests/integration/docker-runner-smoke.test.js

# End-to-end:
# In a spec-kit project that has a company defined and started:
echo 'goal: "echo hello"' > .specops/test/queue/echo.yaml
# Expect: docker ps shows a hermes-agent[ceo] container, then hermes-agent[worker]
# transient. Result artifact appears in .specops/test/echo/result.md.
```

## Critical Files Reference

- [Dockerfile](../Dockerfile) — extend with `hermes-agent` stage or add new `Dockerfile.hermes-agent`
- [docker-compose.yml](../docker-compose.yml) — add `companies` network, mount Docker socket
- [src/runners/hermes-cli.js](../src/runners/hermes-cli.js) — sibling for the docker runner
- [src/core/company-runtime.js](../src/core/company-runtime.js) — `runnerFactory` is the integration seam
- [src/core/capability-gate.js](../src/core/capability-gate.js) — pure-function capability check still used at MCP-call time as defense in depth
- [catalog/binaries/](../catalog/binaries/) — drives which binaries the agent image installs

## Out of Inkrement-5 (defer further)

- Cron for `runner_type: scheduled` — needs containerized version of run-scheduler triggers
- ApprovalService wiring with `requiresApproval` from capability-gate — orthogonal to containerization
- GitHub-Push + Releases — distribution concern
- Per-Company-Catalog-Overrides — read path change in catalog-loader, no container impact
- UI für Catalog-Management — pure frontend work
