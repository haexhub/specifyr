---
name: speckit-haex-paperclip-org
description: 'Manage the org-chart: add or remove roles and map them to providers'
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: haex-paperclip:commands/speckit.haex-paperclip.org.md
---

# Paperclip: Org Chart

View and edit the company structure used by the delegation policy.

## User Input

```text
$ARGUMENTS
```

Subcommands:

- `show` (default) — render the org chart as an indented tree
- `hire <role-id> <title> [--reports-to=<parent-id>] [--provider=<name>]` — add a role
- `fire <role-id>` — remove a role (fails if anyone reports to it)
- `bind <role-id> <provider-name>` — change a role's provider binding
- `providers` — list available provider adapters

## Prerequisites

1. `haex-paperclip-config.yml` exists
2. At least one role with `responsibilities: ["strategy"]` (the top of the chart)

## Steps

### Step 1: Parse subcommand

First token of `$ARGUMENTS`. Default to `show` if empty.

### Step 2: Validate

Before any write, validate:

- New role id matches `^[a-z0-9-]+$`
- `reports_to` (if set) points at an existing role
- Provider name exists in `providers.catalog`

### Step 3: Execute

Invoke `.specify/scripts/bash/org.sh` with the arguments. Writes are performed against
`.specify/extensions/haex-paperclip/haex-paperclip-config.yml` via `yq` in-place.

### Step 4: Render

For `show`, print an indented tree like:

```text
ceo (Claude)
├── product-manager (Claude) — specify, clarify
├── architect (Claude) — plan
│   └── engineering-lead (Claude) — tasks
│       ├── engineer (Codex) — implement
│       └── qa (HTTP) — analyze, checklist
```

## Notes

- The org chart is **the source of truth** for who handles what. Delegation
  (from `/speckit.haex-paperclip.heartbeat`) reads it on every tick.
- You cannot delete a role that has reports — re-parent them first.