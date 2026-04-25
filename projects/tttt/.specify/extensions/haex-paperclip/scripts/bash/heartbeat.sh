#!/usr/bin/env bash
# heartbeat.sh — one heartbeat tick.
# Invoked by /speckit.haex-paperclip.heartbeat and directly via cron/systemd-timer.
set -euo pipefail

EXT_DIR="${SPECKIT_HAEX_PAPERCLIP_DIR:-.specify/extensions/haex-paperclip}"
CONFIG="$EXT_DIR/haex-paperclip-config.yml"
HEARTBEATS="$EXT_DIR/heartbeats.jsonl"
LASTRUN="$EXT_DIR/heartbeats.lastrun"
SCRIPTS_DIR="$EXT_DIR/scripts/bash"

CRON_MODE=false
DRY_RUN=false
GOAL_FILTER=""
SINGLE_STEP=""

for arg in "$@"; do
  case "$arg" in
    --cron)    CRON_MODE=true ;;
    --dry-run) DRY_RUN=true ;;
    --goal=*)  GOAL_FILTER="${arg#--goal=}" ;;
    --step=*)  SINGLE_STEP="${arg#--step=}" ;;
  esac
done

[[ -f "$CONFIG" ]] || { echo "config not found: $CONFIG" >&2; exit 1; }

# Rate-limit cron invocations
min_interval=$(yq eval '.heartbeat.min_interval_seconds // 0' "$CONFIG")
if $CRON_MODE && [[ "$min_interval" != "0" && "$min_interval" != "null" && -f "$LASTRUN" ]]; then
  last=$(cat "$LASTRUN")
  now=$(date +%s)
  gap=$((now - last))
  if (( gap < min_interval )); then
    echo "heartbeat: skipped (last ${gap}s ago, min_interval=${min_interval}s)"
    exit 0
  fi
fi
date +%s > "$LASTRUN"

log() { echo "[heartbeat] $*"; }

step_goals_refresh() {
  log "goals_refresh"
  $DRY_RUN && return
  local goals_dir="$EXT_DIR/goals"
  [[ -d "$goals_dir" ]] || return
  find "$goals_dir" -mindepth 2 -maxdepth 2 -name goal.yml -type f | while read -r f; do
    local slug; slug=$(basename "$(dirname "$f")")
    [[ -z "$GOAL_FILTER" || "$slug" == "$GOAL_FILTER" ]] || continue
    local status; status=$(yq eval '.status' "$f")
    [[ "$status" == "active" ]] || continue
    jq -n --arg ts "$(date -Is)" --arg slug "$slug" \
      '{ts:$ts, type:"goal.refresh", slug:$slug}' \
      >> "$(dirname "$f")/events.jsonl"
  done
}

step_budget_check() {
  log "budget_check"
  $DRY_RUN && return 0
  # Tolerate non-zero exit so a single blocked role does not abort the tick.
  bash "$SCRIPTS_DIR/budget.sh" check --all || true
}

step_delegate_pending() {
  log "delegate_pending"
  if $DRY_RUN; then
    log "(dry-run: would walk goals × stages and invoke provider bindings)"
    return
  fi
  # v0.1: emit a stub event. Real delegation requires integration with your
  # task source (spec-kit task files, issue tracker, etc.) and is the natural
  # place to customize per project.
  jq -n --arg ts "$(date -Is)" \
    '{ts:$ts, type:"delegation.stub", note:"v0.1 placeholder"}' \
    >> "$EXT_DIR/delegations.jsonl"
}

step_cost_report() {
  log "cost_report"
  $DRY_RUN && return
  local ledger="$EXT_DIR/budgets/ledger.jsonl"
  local today; today=$(date +%Y-%m-%d)
  local cost=0
  if [[ -f "$ledger" ]]; then
    cost=$(jq -s --arg d "$today" \
      '[.[] | select((.ts // "") | startswith($d)) | (.cost_eur // 0)] | add // 0' \
      "$ledger")
  fi
  jq -n --arg ts "$(date -Is)" --argjson cost "$cost" \
    '{ts:$ts, cost_today_eur:$cost}' >> "$HEARTBEATS"
}

run_step() {
  case "$1" in
    goals_refresh)    step_goals_refresh ;;
    budget_check)     step_budget_check ;;
    delegate_pending) step_delegate_pending ;;
    cost_report)      step_cost_report ;;
    *)                log "unknown step: $1" ;;
  esac
}

# Resolve step sequence: CLI flag > config > extension.yml defaults
if [[ -n "$SINGLE_STEP" ]]; then
  steps=("$SINGLE_STEP")
else
  mapfile -t steps < <(yq eval '.heartbeat.steps[]?' "$CONFIG" 2>/dev/null)
  if [[ "${#steps[@]}" -eq 0 ]]; then
    steps=(goals_refresh budget_check delegate_pending cost_report)
  fi
fi

log "tick $(date -Is) steps=[${steps[*]}]${DRY_RUN:+ (dry-run)}"
for step in "${steps[@]}"; do
  run_step "$step"
done
