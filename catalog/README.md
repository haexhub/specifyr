# Central Tool & Skill Catalog

This catalog is the **single source of truth** for tools and skills available to all companies declared on this specifyr instance.

```
catalog/
├── tools/    YAML manifest per MCP server / external tool. Agents reference by ID.
└── skills/   Markdown body per seed skill. Injected into agent system prompt.
```

When an agent's `agents/<role>.md` lists `tools.mcp: [github]` or `skills: [tdd]`, the runtime looks up the entry here, resolves the spec, and uses it at spawn time. The validator (in [speckit-company](https://github.com/haex/speckit-company)) refuses to start a company that references unknown IDs or lacks the capabilities required by a referenced tool.

## Adding a tool

Drop a new file `catalog/tools/<id>.yml`:

```yaml
id: my-tool
name: "My Tool"
type: mcp                       # mcp | builtin | custom
transport: stdio                # for type=mcp
command: "uvx"
args: ["mcp-server-mything"]
env_keys: [MY_TOKEN]
description: "What this tool does in one sentence."
required_capabilities:
  - secrets:read_env
  - network:http
tags: [domain, category]
```

## Minimum-required capability principle

`required_capabilities` is the **minimum to invoke the tool/binary at all**, not the maximum needed for every operation. For most binaries that's just `shell:execute`. Exceptions are tools whose entire purpose is a capability class — `curl` requires `network:http`, `rg` requires `filesystem:read`. Use-case-specific capabilities (filesystem:write for `git commit`, network:http for `gh pr create`) belong in the agent's own `capabilities` list, not in the binary manifest. This way a single binary manifest serves read-only and write-mode agents alike, each with the minimum permissions they actually need.

## Adding a skill

Drop a new file `catalog/skills/<id>.md`:

```markdown
---
id: my-skill
name: "My Skill"
description: "One-sentence summary."
tags: [quality, engineering]
---

# Skill body — gets prepended to the agent's system prompt.

When you face situation X, do Y. Specifically:
1. ...
2. ...

Never do Z because ...
```

## Slash command

Use `/speckit.company.catalog` in any spec-kit project to list, add, remove, and inspect entries.

## Catalog scope

This is a **machine-wide** catalog (all companies on this specifyr install share it). For per-company overrides, drop files into `<spec-kit-project>/.specify/org/catalog/{tools,skills}/` — those take precedence over the global catalog.
