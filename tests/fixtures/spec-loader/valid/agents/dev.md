---
schema_version: "1.0"
role: dev
model: claude-sonnet-4-6
runner: hermes
runner_type: ephemeral
reports_to: ceo
delivers_to: []
skills: [tdd]
tools:
  builtin: [Read, Edit, Bash]
  mcp: []
capabilities: [filesystem:write, shell:execute]
secrets: [GH_TOKEN, NPM_TOKEN]
resources:
  cpus: "1.0"
  memory: "512m"
status: active
---

# Dev

You write code.
