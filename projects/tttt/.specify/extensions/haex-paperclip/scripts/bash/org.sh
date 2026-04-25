#!/usr/bin/env bash
# org.sh — Paperclip org-chart management.
# Called by /speckit.haex-paperclip.org.
set -euo pipefail

EXT_DIR="${SPECKIT_HAEX_PAPERCLIP_DIR:-.specify/extensions/haex-paperclip}"
CONFIG="$EXT_DIR/haex-paperclip-config.yml"

require_config() {
  [[ -f "$CONFIG" ]] || { echo "config not found: $CONFIG" >&2; exit 1; }
}

cmd="${1:-show}"; shift || true

case "$cmd" in
  show)
    require_config
    yq eval -o=json '.org.roles // []' "$CONFIG" | jq -r '
      . as $roles |
      def render($parent; $indent):
        ($roles | map(select(.reports_to == $parent)))[] as $r
        | "\($indent)\($r.id) — \($r.title // "")"
          + (if ($r.responsibilities // [] | length) > 0
             then " [" + ($r.responsibilities | join(", ")) + "]"
             else "" end),
          render($r.id; $indent + "  ");
      render(null; "")
    '
    ;;
  hire)
    require_config
    id="${1:?usage: hire <id> <title> [--reports-to=<id>] [--provider=<name>] [--responsibilities=s1,s2]}"
    title="${2:?title required}"
    shift 2
    parent_json="null"
    provider=""
    resp_json="[]"
    for arg in "$@"; do
      case "$arg" in
        --reports-to=*)
          p="${arg#--reports-to=}"
          parent_json=$(jq -nc --arg p "$p" '$p') ;;
        --provider=*)
          provider="${arg#--provider=}" ;;
        --responsibilities=*)
          resp_json=$(echo "${arg#--responsibilities=}" \
            | jq -Rc 'split(",") | map(gsub("^\\s+|\\s+$";""))') ;;
      esac
    done
    [[ "$id" =~ ^[a-z0-9-]+$ ]] || { echo "invalid role id: $id" >&2; exit 1; }
    exists=$(id="$id" yq eval '.org.roles[]? | select(.id == strenv(id)) | .id' "$CONFIG")
    [[ -z "$exists" ]] || { echo "role already exists: $id" >&2; exit 1; }
    id="$id" title="$title" parent_json="$parent_json" resp_json="$resp_json" \
      yq eval -i '
        .org.roles = ((.org.roles // []) + [{
          "id": strenv(id),
          "title": strenv(title),
          "reports_to": env(parent_json),
          "responsibilities": env(resp_json)
        }])
      ' "$CONFIG"
    if [[ -n "$provider" ]]; then
      id="$id" provider="$provider" yq eval -i '.providers.bindings[strenv(id)] = strenv(provider)' "$CONFIG"
    fi
    jq -nc --arg id "$id" '{type:"org.hire", id:$id}'
    ;;
  fire)
    require_config
    id="${1:?usage: fire <id>}"
    reports=$(id="$id" yq eval '[.org.roles[]? | select(.reports_to == strenv(id))] | length' "$CONFIG")
    [[ "$reports" == "0" ]] || { echo "role $id has $reports direct reports; re-parent them first" >&2; exit 1; }
    id="$id" yq eval -i 'del(.org.roles[] | select(.id == strenv(id))) | del(.providers.bindings[strenv(id)])' "$CONFIG"
    jq -nc --arg id "$id" '{type:"org.fire", id:$id}'
    ;;
  bind)
    require_config
    id="${1:?usage: bind <id> <provider>}"
    provider="${2:?provider required}"
    exists=$(id="$id" yq eval '.org.roles[]? | select(.id == strenv(id)) | .id' "$CONFIG")
    [[ -n "$exists" ]] || { echo "no such role: $id" >&2; exit 1; }
    known=$(provider="$provider" yq eval '.providers.catalog[]? | select(.name == strenv(provider)) | .name' "$CONFIG")
    [[ -n "$known" ]] || { echo "unknown provider: $provider (see: org.sh providers)" >&2; exit 1; }
    id="$id" provider="$provider" yq eval -i '.providers.bindings[strenv(id)] = strenv(provider)' "$CONFIG"
    jq -nc --arg id "$id" --arg p "$provider" '{type:"org.bind", id:$id, provider:$p}'
    ;;
  providers)
    require_config
    yq eval '.providers.catalog[]?.name' "$CONFIG"
    ;;
  help|*)
    cat <<'USAGE'
Usage:
  org.sh show
  org.sh hire <id> <title> [--reports-to=<id>] [--provider=<name>] [--responsibilities=stage1,stage2]
  org.sh fire <id>
  org.sh bind <id> <provider>
  org.sh providers
USAGE
    ;;
esac
