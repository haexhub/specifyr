#!/bin/sh
# Container entrypoint shim. Runs once per container start, before the main
# Specifyr server process. Idempotent — re-running the same container is safe.
#
# Sole job today: seed the user-level claude-agent-acp settings file with
# `defaultMode: "bypassPermissions"`. claude-agent-acp 0.33.1 ignores any
# permissionMode hint passed via the ACP session/new `_meta` field
# (acp-agent.js line ~1392: the SettingsManager-derived value is spread
# AFTER `...userProvidedOptions`, so it always wins). The Claude Code SDK
# then refuses Write/Edit tool calls under `default` mode in this proxy
# setup — the model text-replies "permission denied" without ever issuing
# a tool_use. Setting bypassPermissions in the user settings is the only
# documented path that actually flips the SDK's permission gate.
#
# Why a runtime script and not a static COPY into the image:
#   - Image-baked `/home/node/.claude/settings.json` works for named volumes
#     (Docker auto-populates on first init from the image content).
#   - With a bind mount (dev / Ansible default), the host directory shadows
#     the image content entirely — a static file would be invisible inside
#     the container. The script runs after mounts are in place, so it sees
#     and writes the actual runtime target regardless of mount type.
#
# The file is only written when missing, so operator-supplied
# /home/node/.claude/settings.json (e.g. for stricter permission policies)
# is preserved across container restarts.

set -eu

CLAUDE_DIR="${HOME:-/home/node}/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
  mkdir -p "$CLAUDE_DIR"
  cat > "$SETTINGS_FILE" <<'JSON'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
JSON
fi

exec "$@"
