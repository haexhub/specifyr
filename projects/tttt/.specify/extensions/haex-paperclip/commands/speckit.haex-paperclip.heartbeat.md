---
description: "Run one heartbeat tick: refresh goals, check budgets, delegate pending work"
scripts:
  sh: ../../scripts/bash/heartbeat.sh
---

# Paperclip: Heartbeat

A single pulse of the zero-human workflow. Invoke manually, or schedule via
cron/systemd-timer using `scripts/bash/heartbeat.sh` directly.

## User Input

```text
$ARGUMENTS
```

Optional flags:

- `--goal=<slug>` — restrict the tick to one goal
- `--dry-run` — show what would happen, do not write
- `--step=<name>` — run a single step from the configured sequence

## Prerequisites

1. `haex-paperclip-config.yml` exists with at least one role and one provider binding
2. At least one goal exists with status `active`
3. `jq` and `yq` are available

## Steps

The tick executes the ordered steps from `extension.yml::defaults.heartbeat.steps`
(default order below):

### Step 1: `goals_refresh`

For each active goal, count linked specs, unresolved tasks, and time since last
activity. Write a snapshot to the goal's `events.jsonl`.

### Step 2: `budget_check`

Call `/speckit.haex-paperclip.budget check --all`. If any role hits a `block`
threshold, skip delegation for that role during this tick and record an event.

### Step 3: `delegate_pending`

For each active goal × unresolved task:

1. Determine the target role using `defaults.delegation.stage_to_role`
2. Look up the provider via `providers.bindings[<role>]`
3. Invoke the provider adapter under `.specify/extensions/haex-paperclip/scripts/bash/providers/<name>.sh` with a JSON payload `{goal, task, role, stage}` on stdin
4. Capture the adapter's cost report and pipe it to `/speckit.haex-paperclip.budget record`

### Step 4: `cost_report`

Append a summary line to `.specify/extensions/haex-paperclip/heartbeats.jsonl`:

```json
{"ts":"2026-04-24T20:00:00Z","goals":3,"delegated":7,"skipped_budget":1,"cost_eur":2.41}
```

## Scheduling

Run headlessly every 30 minutes:

```bash
# crontab -e
*/30 * * * * /path/to/.specify/extensions/haex-paperclip/scripts/bash/heartbeat.sh --cron >> ~/.haex-paperclip.log 2>&1
```

Or with systemd:

```ini
# ~/.config/systemd/user/paperclip-heartbeat.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
```

## Notes

- `min_interval_seconds` in config guards against cron overlap.
- `--dry-run` is useful for testing delegation routing before binding real
  providers.
