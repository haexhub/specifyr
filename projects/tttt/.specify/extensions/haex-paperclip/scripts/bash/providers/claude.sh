#!/usr/bin/env bash
# claude.sh — provider adapter for the `claude` CLI.
# Contract:
#   stdin:  JSON {goal, task, role, stage}
#   stdout: JSON {status, cost_eur, tokens_in, tokens_out, output, note}
set -euo pipefail

if ! command -v claude >/dev/null; then
  jq -nc '{status:"error", reason:"claude CLI not found on PATH"}'
  exit 1
fi

payload=$(cat)
goal=$(jq -r  '.goal  // "unknown"' <<<"$payload")
task=$(jq -r  '.task  // ""'        <<<"$payload")
role=$(jq -r  '.role  // ""'        <<<"$payload")
stage=$(jq -r '.stage // ""'        <<<"$payload")

read -r -d '' prompt <<PROMPT || true
You are acting as the "${role}" role for the goal "${goal}".
Current spec-kit stage: ${stage}

Task:
${task}

Execute this task according to your role's responsibilities. Return your work
product concisely.
PROMPT

model="${SPECKIT_HAEX_PAPERCLIP_CLAUDE_MODEL:-}"
if [[ -n "$model" ]]; then
  output=$(claude -p --model "$model" "$prompt" 2>&1) || output="(claude invocation failed: $output)"
else
  output=$(claude -p "$prompt" 2>&1) || output="(claude invocation failed: $output)"
fi

# The `claude` CLI does not expose token/cost on stdout. Real cost tracking
# belongs in a custom wrapper reading the API response headers, or in the
# Anthropic usage dashboard. For a v0.1 adapter we report zeros with a note.
jq -nc --arg output "$output" \
  '{status:"ok", cost_eur:0.0, tokens_in:0, tokens_out:0, output:$output,
    note:"cost_tracking_unimplemented"}'
