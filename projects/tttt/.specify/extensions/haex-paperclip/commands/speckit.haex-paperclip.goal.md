---
description: "Create, list, or inspect long-running business goals tracked by Paperclip"
scripts:
  sh: ../../scripts/bash/goal.sh
---

# Paperclip: Goal

Manage long-running **business goals** that persist across specs, plans, and
implementations. Unlike a spec, a goal is not tied to a single feature branch —
it is the *why* behind many specs.

## User Input

```text
$ARGUMENTS
```

Subcommands (first token of `$ARGUMENTS`):

- `new "<description>"` — create a new goal and store it as a YAML file
- `list` — list all goals with status (`active`, `paused`, `done`)
- `show <slug>` — print a single goal's full record
- `link <slug> <spec-slug>` — attach a spec to a goal (the `after_specify` hook uses this)
- `status <slug> <active|paused|done>` — change a goal's status

## Prerequisites

1. `haex-paperclip-config.yml` exists under `.specify/extensions/haex-paperclip/`
2. `yq` is available on PATH

## Steps

### Step 1: Route subcommand

Parse the first token of `$ARGUMENTS`. If it's missing or `help`, print the
usage block above and exit 0.

### Step 2: Execute

Invoke `{SCRIPT}` with the parsed arguments. The script is responsible for:

- Writing goal files to `.specify/extensions/haex-paperclip/goals/<slug>/goal.yml`
- Mirroring each goal into `.specify/goals/<slug>/goal.md` for spec-kit navigation
- Emitting a JSON event line `{"type":"goal.<verb>","slug":"..."}` on stdout

### Step 3: Report

Summarize the result in plain markdown for the user. For `list`, render a
table with columns: slug, title, status, attached specs, budget usage %.

## Storage

Each goal lives at:

```text
.specify/extensions/haex-paperclip/goals/<slug>/
├── goal.yml         # canonical record (title, description, owner_role, status, created_at)
├── specs.yml        # linked spec slugs
└── events.jsonl     # append-only event log
```

## Configuration

Goals inherit the default owner role from `haex-paperclip-config.yml::org.roles`
where `responsibilities` includes `"strategy"` (usually `ceo`).
