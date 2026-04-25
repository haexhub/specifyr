#!/usr/bin/env bash
# http.sh — generic HTTP provider adapter.
# Contract:
#   stdin:  JSON {goal, task, role, stage}
#   stdout: JSON {status, cost_eur, tokens_in, tokens_out, output?, note?}
#
# The webhook is expected to respond with a body matching the output JSON
# contract. If it returns a different shape, wrap it at the HTTP layer rather
# than post-processing here.
set -euo pipefail

EXT_DIR="${SPECKIT_HAEX_PAPERCLIP_DIR:-.specify/extensions/haex-paperclip}"
CONFIG="$EXT_DIR/haex-paperclip-config.yml"

payload=$(cat)

webhook=$(yq eval '.providers.http.webhook_url // ""' "$CONFIG")
if [[ -z "$webhook" ]]; then
  jq -nc '{status:"error", reason:"no webhook_url configured at .providers.http.webhook_url"}'
  exit 1
fi

auth_header=$(yq eval '.providers.http.auth_header // ""' "$CONFIG")
curl_args=(-fsS -X POST "$webhook" -H "Content-Type: application/json" --data "$payload")
[[ -n "$auth_header" ]] && curl_args+=(-H "$auth_header")

if ! response=$(curl "${curl_args[@]}" 2>&1); then
  jq -nc --arg err "$response" '{status:"error", reason:$err}'
  exit 1
fi

# Passthrough — validate it's JSON, else wrap
if echo "$response" | jq -e . >/dev/null 2>&1; then
  echo "$response"
else
  jq -nc --arg raw "$response" '{status:"ok", cost_eur:0.0, tokens_in:0, tokens_out:0, output:$raw, note:"non_json_response_wrapped"}'
fi
