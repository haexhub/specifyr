---
description: "Status overview of goals, agents, budget usage, and recent activity"
scripts:
  sh: ../../scripts/bash/dashboard.sh
---

# Paperclip: Dashboard

One-shot status view — think `git status` for your autonomous company.

## User Input

```text
$ARGUMENTS
```

Optional flags:

- `--json` — emit machine-readable JSON instead of the rendered table
- `--goal=<slug>` — focus on one goal
- `--since=<duration>` — only count activity within the given window (e.g. `24h`, `7d`)

## Prerequisites

1. Paperclip configured
2. At least one goal exists

## Steps

### Step 1: Collect

Read in parallel:

- all `goals/<slug>/goal.yml`
- all `budgets/<role>.state.yml`
- last N lines of `heartbeats.jsonl` (default 20)

### Step 2: Render

Print three sections:

#### Goals

```text
Slug              Status   Specs   Open Tasks   Last Activity
----------------  -------  ------  -----------  ---------------
launch-mrr-1m     active   4       11           2h ago
killer-feature    paused   1       0            3d ago
```

#### Budgets

```text
Role              Monthly    Spent    %      Today    Policy
----------------  ---------  -------  -----  -------  ----------
engineer          €300       €187.12  62%    €8.40    warn @ 80%
qa                €50        €49.80   99%    €0.00    block @ 100%
architect         €150       €12.40   8%     €0.00    —
```

#### Recent Heartbeats

```text
Timestamp             Delegated   Blocked   Cost
--------------------  ----------  --------  -------
2026-04-24T20:00:00Z  7           1         €2.41
2026-04-24T19:30:00Z  5           0         €1.88
```

### Step 3: Warn

If any role is `>= 90%` and policy mode is not `block`, surface a top-level
warning so the human can react before the next heartbeat blocks the run.

## Notes

- `--json` output is stable and safe to pipe into other tools.
- This command is read-only — it never writes.
