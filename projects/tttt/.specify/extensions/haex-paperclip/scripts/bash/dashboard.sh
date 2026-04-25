#!/usr/bin/env bash
# dashboard.sh — Paperclip read-only status overview.
# Called by /speckit.haex-paperclip.dashboard.
set -euo pipefail

EXT_DIR="${SPECKIT_HAEX_PAPERCLIP_DIR:-.specify/extensions/haex-paperclip}"
CONFIG="$EXT_DIR/haex-paperclip-config.yml"
GOALS_DIR="$EXT_DIR/goals"
BUDGETS_DIR="$EXT_DIR/budgets"
HEARTBEATS="$EXT_DIR/heartbeats.jsonl"

json_mode=false
goal_filter=""
for arg in "$@"; do
  case "$arg" in
    --json)   json_mode=true ;;
    --goal=*) goal_filter="${arg#--goal=}" ;;
  esac
done

collect_goals() {
  [[ -d "$GOALS_DIR" ]] || { echo "[]"; return; }
  {
    find "$GOALS_DIR" -mindepth 2 -maxdepth 2 -name goal.yml -type f 2>/dev/null \
    | while read -r f; do
        dir=$(dirname "$f")
        slug=$(basename "$dir")
        [[ -z "$goal_filter" || "$slug" == "$goal_filter" ]] || continue
        specs=$(yq eval '.specs // [] | length' "$dir/specs.yml" 2>/dev/null || echo 0)
        events=0
        [[ -f "$dir/events.jsonl" ]] && events=$(wc -l < "$dir/events.jsonl" | tr -d ' ')
        yq eval -o=json "$f" | jq --argjson s "$specs" --argjson e "$events" \
          '. + {specs_count:$s, event_count:$e}'
      done
  } | jq -s '.'
}

collect_budgets() {
  [[ -d "$BUDGETS_DIR" && -f "$CONFIG" ]] || { echo "[]"; return; }
  {
    find "$BUDGETS_DIR" -maxdepth 1 -name "*.state.yml" -type f 2>/dev/null \
    | while read -r f; do
        role=$(basename "$f" .state.yml)
        monthly=$(role="$role" yq eval ".budgets.per_role[strenv(role)].monthly_limit_eur // null" "$CONFIG")
        yq eval -o=json "$f" | jq --arg role "$role" --arg m "$monthly" \
          '. + {role:$role, monthly_limit_eur: (if $m == "null" then null else ($m|tonumber) end)}'
      done
  } | jq -s '.'
}

collect_heartbeats() {
  [[ -f "$HEARTBEATS" ]] || { echo "[]"; return; }
  tail -n 20 "$HEARTBEATS" | jq -s '.'
}

goals_json=$(collect_goals)
budgets_json=$(collect_budgets)
heartbeats_json=$(collect_heartbeats)

if $json_mode; then
  jq -n --argjson g "$goals_json" --argjson b "$budgets_json" --argjson h "$heartbeats_json" \
    '{goals:$g, budgets:$b, heartbeats:$h}'
  exit 0
fi

echo "=== Goals ==="
echo "$goals_json" | jq -r '
  (["SLUG","STATUS","SPECS","EVENTS"] | @tsv),
  (.[] | [.slug, .status, (.specs_count|tostring), (.event_count|tostring)] | @tsv)
' | column -t -s $'\t'

echo
echo "=== Budgets ==="
echo "$budgets_json" | jq -r '
  (["ROLE","MONTHLY_EUR","SPENT_EUR","TODAY_EUR","PERIOD"] | @tsv),
  (.[] | [.role, (.monthly_limit_eur // "—" | tostring), (.spent_eur|tostring), (.spent_today_eur|tostring), .period] | @tsv)
' | column -t -s $'\t'

echo
echo "=== Recent Heartbeats (last 20) ==="
echo "$heartbeats_json" | jq -r '
  if length == 0 then "(no heartbeats recorded)"
  else (["TIMESTAMP","COST_TODAY_EUR"] | @tsv),
       (.[] | [.ts, (.cost_today_eur // "—" | tostring)] | @tsv)
  end
' | column -t -s $'\t'
