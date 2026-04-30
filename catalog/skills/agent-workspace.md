---
id: agent-workspace
name: "Agent Workspace"
description: >
  Use for any agent that needs to persist data across task boundaries — findings,
  intermediate state, outputs for other agents. Do not use for pure read-only or
  ephemeral agents.
tags:
  - persistence
  - workflow
---

# Agent Workspace

Your persistent workspace directory is injected into your context by the runtime before this skill. Use it as follows:

**What belongs in the workspace:**
- Findings and artifacts that must survive task boundaries → `workspace/memory/<name>.yaml`
- Outputs intended for consumption by other agents → `workspace/output/<name>.yaml`
- Intermediate state you need to resume an interrupted task → `workspace/state/<name>.yaml`

**What does NOT belong in the workspace:**
- Scratchpad reasoning — keep that in working memory, never write it to disk.
- Outputs that belong to a shared company location (e.g. strategy catalog) — write those to their canonical path, not your workspace.

**Format rules:**
- Use YAML for structured data other agents may read.
- Use plain text or Markdown only for human-readable notes with no downstream consumers.
- Never invent a new subdirectory without a clear reason; the three above cover almost everything.

**Before writing:** check if the file already exists and merge rather than overwrite, unless a full replacement is clearly correct.
