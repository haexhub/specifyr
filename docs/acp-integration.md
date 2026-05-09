# Connecting external ACP clients to specifyr

specifyr ships an ACP (Agent Client Protocol) server at `bin/specifyr-acp.js`. Any editor or UI that speaks ACP can spawn it as a subprocess and drive specifyr runs.

## Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "specifyr": {
      "command": "node",
      "args": ["/absolute/path/to/specifyr/bin/specifyr-acp.js"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Open Zed's agent panel and pick **specifyr**.

## AionUi

In AionUi → settings → Custom Agent → add:

- Name: `specifyr`
- Command: `node /absolute/path/to/specifyr/bin/specifyr-acp.js`
- Working directory: your project

## Notes

- The `cwd` of the spawned process must contain a `.specifyr/` directory — that is, specifyr must already be initialized for the project. Run `node ./src/index.js init` in the project root if needed.
- Approvals appear in the ACP client's permission UI (Zed's permission panel, AionUi's tool prompt), not in the Nuxt dashboard. When you click *allow*, the ACP client sends `session/request_permission` outcome `selected: allow_once`, which `AcpApprovalTransport` translates to `approved` and resolves the CapabilityApprovalService request.
- Run state is shared. A turn started via ACP shows up in the Nuxt UI's history view exactly like a CLI- or HTTP-driven turn — same on-disk events under `.specifyr/<slug>/steps/<stepId>/sessions/<sid>.events.jsonl`.
- The ACP session id is encoded as `specifyr:1:<slug>:<stepId>:<sid>`. `session/load` resumes any session that was previously created.
- Internally, every runner output is converted to ACP `SessionUpdate` shape ([src/runners/claude-stream-to-acp.js](../src/runners/claude-stream-to-acp.js) for Claude/Hermes; AcpRunner forwards verbatim). The ACP server reads those persisted updates and forwards them as `session/update` notifications — so the editor sees the same content the Nuxt UI does.

## Troubleshooting

**The agent process exits immediately on connect**

Check that `cwd` resolves to a directory containing `.specifyr/<slug>/`. The server logs nothing on stdout (stdout is the ACP wire) — check the editor's agent log for stderr.

**No tools fire / agent says "I can't use tools"**

Speckit runs are ACP-only. Configure the Speckit workflow agent in Settings, and make sure the selected `acp:<name>` entry exists in `.specifyr/config.json` with a working `binary` (and `args` when the ACP client requires them).

**Approval prompt never appears**

Confirm the agent's spec at `.specify/org/agents/<role>.md` declares `notify_via: ["acp"]` (or another channel that is wired). If the agent has no notification channels at all, requests will fall through to the configured `on_timeout` policy.
