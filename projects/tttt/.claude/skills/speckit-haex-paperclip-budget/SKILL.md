---
name: speckit-haex-paperclip-budget
description: Set, check, or record costs against agent budgets
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: haex-paperclip:commands/speckit.haex-paperclip.budget.md
---

# Paperclip: Budget

Single entry point for everything money-related: limits, checks, cost recording.

## User Input

```text
$ARGUMENTS
```

Subcommands:

- `show [<role>]` — print budget status for one role or all (tabular)
- `set <role> --monthly-eur=<n> [--daily-eur=<n>]` — set or update a role's cap
- `check [<role>|--all]` — evaluate enforcement (exits non-zero if `block`)
- `record <role> <cost_eur> [--tokens-in=<n> --tokens-out=<n>]` — append spend
- `reset <role>` — zero the current-period counters (use with care)

## Prerequisites

1. `haex-paperclip-config.yml` has a `budgets` section with a filled-in `policy`
2. Role id exists in `org.roles`

## Steps

### Step 1: Load policy

Read `budgets` from `.specify/extensions/haex-paperclip/haex-paperclip-config.yml`.
Merge `per_role` overrides on top of the global policy.

### Step 2: Load state

Current-period counters live in:

```text
.specify/extensions/haex-paperclip/budgets/<role>.state.yml
```

Format:

```yaml
period: "2026-04"      # YYYY-MM
spent_eur: 37.42
spent_today_eur: 4.10
last_event_at: "2026-04-24T19:45:00Z"
```

### Step 3: Dispatch

Invoke `.specify/scripts/bash/budget.sh` with the parsed subcommand. The script is the single writer
for `*.state.yml` files and appends to `.specify/extensions/haex-paperclip/budgets/ledger.jsonl`.

### Step 4: Enforce

For `check`, evaluate `policy.thresholds` against `spent_eur / monthly_limit_eur`:

- Find the highest threshold whose `at` is ≤ current ratio
- Return its `mode` and exit accordingly:
    - `warn` → exit 0, write warning line to stderr
    - `throttle` → sleep N seconds, then exit 0
    - `block` → exit 2 with message `budget_block: <role> at <pct>% of <limit>`
    - `escalate` → exit 3 and emit an `escalation.requested` event; the agent
      is expected to surface this to the human via whatever channel the
      project uses

## Notes

- This command is called twice per implementation by the hooks in `extension.yml`:
  `before_implement` → `check`, `after_implement` → `record`.
- When the calendar month rolls over, the next `record` invocation resets the
  monthly counter and archives the previous period to
  `.specify/extensions/haex-paperclip/budgets/history/<role>-<period>.yml`.