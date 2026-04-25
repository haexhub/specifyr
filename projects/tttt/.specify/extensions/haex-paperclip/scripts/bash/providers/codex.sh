#!/usr/bin/env bash
# codex.sh — provider adapter for the `codex` CLI.
# Contract:
#   stdin:  JSON {goal, task, role, stage}
#   stdout: JSON {status, cost_eur, tokens_in, tokens_out, output, note}
set -euo pipefail

if ! command -v codex >/dev/null; then
  jq -nc '{status:"error", reason:"codex CLI not found on PATH"}'
  exit 1
fi

payload=$(cat)
goal=$(jq -r  '.goal  // "unknown"' <<<"$payload")
task=$(jq -r  '.task  // ""'        <<<"$payload")
role=$(jq -r  '.role  // ""'        <<<"$payload")
stage=$(jq -r '.stage // ""'        <<<"$payload")

read -r -d '' prompt <<PROMPT || true
Role: ${role}
Goal: ${goal}
Stage: ${stage}
Task: ${task}
PROMPT

output=$(codex exec "$prompt" 2>&1) || output="(codex invocation failed: $output)"

jq -nc --arg output "$output" \
  '{status:"ok", cost_eur:0.0, tokens_in:0, tokens_out:0, output:$output,
    note:"cost_tracking_unimplemented"}'
