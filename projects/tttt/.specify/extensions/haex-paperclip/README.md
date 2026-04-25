# spec-kit-haex-paperclip

A [Spec Kit](https://github.com/github/spec-kit) extension that models the
[Paperclip](https://github.com/paperclipai/paperclip) workflow inside the
spec-kit command surface.

**Manage business goals, not pull requests** — from within your existing
spec-kit project, without a separate server.

## What you get

| Command | Purpose |
|---|---|
| `/speckit.haex-paperclip.goal` | Create and track long-running business goals |
| `/speckit.haex-paperclip.org` | Define your company: roles, reporting lines, provider bindings |
| `/speckit.haex-paperclip.heartbeat` | One tick of the autonomous loop (cron-friendly) |
| `/speckit.haex-paperclip.budget` | Set, check, record per-role budgets with configurable enforcement |
| `/speckit.haex-paperclip.dashboard` | Read-only status view across goals, agents, spend |

Plus hooks: specs get linked to goals after `/speckit.specify`, tasks get
delegated after `/speckit.tasks`, budget is checked before `/speckit.implement`
and recorded after.

## Install

From this checkout:

```bash
cd /path/to/your/spec-kit-project
specify extension add --dev /home/haex/Projekte/haex-paperclip
```

Then copy the config:

```bash
cp .specify/extensions/haex-paperclip/config-template.yml \
   .specify/extensions/haex-paperclip/haex-paperclip-config.yml
```

Edit `haex-paperclip-config.yml` to define your org chart and budget policy
(see next section).

## Configuration

`config-template.yml` ships with **no default values** — every field is a
decision the end user makes. After `specify extension add haex-paperclip`, copy
the template and fill in:

1. `org.roles` — your company structure
2. `providers.bindings` — which provider each role uses
3. `delegation.stage_to_role` — who owns which spec-kit stage
4. `budgets.per_role` — monthly/daily caps and enforcement thresholds
5. `heartbeat` — safety rails for cron-driven ticks

Each section in the template documents its schema inline. Commented examples
show the shape; delete or replace them.

## Storage layout

```text
.specify/extensions/haex-paperclip/
├── haex-paperclip-config.yml           # org, providers, budgets
├── goals/
│   └── <slug>/
│       ├── goal.yml
│       ├── specs.yml
│       └── events.jsonl
├── budgets/
│   ├── <role>.state.yml           # current period counters
│   ├── ledger.jsonl               # append-only cost log
│   └── history/
│       └── <role>-<period>.yml    # archived periods
├── heartbeats.jsonl               # tick-by-tick summary
└── scripts/bash/providers/        # provider adapters
```

## Providers

Built-in adapters live under `scripts/bash/providers/`:

- `claude.sh` — invokes the `claude` CLI
- `codex.sh` — invokes the `codex` CLI
- `http.sh` — POSTs to an arbitrary webhook (for bring-your-own agents)

A provider receives `{goal, task, role, stage}` as JSON on stdin and MUST
return JSON on stdout with at minimum:

```json
{"status":"ok","cost_eur":0.42,"tokens_in":1234,"tokens_out":567}
```

## Scheduling

Run headless every 30 minutes:

```bash
*/30 * * * * /path/to/.specify/extensions/haex-paperclip/scripts/bash/heartbeat.sh --cron >> ~/.haex-paperclip.log 2>&1
```

## Status

`v0.1.0` — scaffolded. Scripts under `scripts/bash/` are stubs; see each
command's `.md` file for the intended behavior.
