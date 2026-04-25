#!/usr/bin/env bash
# budget.sh — Paperclip budget state and enforcement.
# Called by /speckit.haex-paperclip.budget and by the before/after_implement hooks.
set -euo pipefail

EXT_DIR="${SPECKIT_HAEX_PAPERCLIP_DIR:-.specify/extensions/haex-paperclip}"
CONFIG="$EXT_DIR/haex-paperclip-config.yml"
BUDGETS_DIR="$EXT_DIR/budgets"
LEDGER="$BUDGETS_DIR/ledger.jsonl"
mkdir -p "$BUDGETS_DIR/history"

require_config() {
  [[ -f "$CONFIG" ]] || { echo "config not found: $CONFIG" >&2; exit 1; }
}
current_period() { date +%Y-%m; }
today_str()      { date +%Y-%m-%d; }
state_path()     { echo "$BUDGETS_DIR/$1.state.yml"; }
is_number()      { [[ "$1" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; }

ensure_state() {
  local role="$1"
  local sp; sp=$(state_path "$role")
  local cur; cur=$(current_period)
  if [[ ! -f "$sp" ]]; then
    period="$cur" yq eval -n '
      .period = strenv(period) |
      .spent_eur = 0 |
      .spent_today_eur = 0 |
      .last_event_at = null |
      .last_event_date = null
    ' > "$sp"
    return
  fi
  local stored; stored=$(yq eval '.period' "$sp")
  if [[ "$stored" != "$cur" ]]; then
    cp "$sp" "$BUDGETS_DIR/history/${role}-${stored}.yml"
    period="$cur" yq eval -i '
      .period = strenv(period) | .spent_eur = 0 | .spent_today_eur = 0
    ' "$sp"
  fi
}

role_field() {
  local role="$1" field="$2"
  role="$role" yq eval ".budgets.per_role[strenv(role)].${field} // null" "$CONFIG"
}

configured_roles() {
  yq eval '.budgets.per_role | keys | .[]' "$CONFIG" 2>/dev/null || true
}

cmd="${1:-show}"; shift || true

case "$cmd" in
  show)
    require_config
    role="${1:-}"
    if [[ -n "$role" ]]; then roles="$role"; else roles=$(configured_roles); fi
    printf "%-20s  %-12s  %-12s  %-8s  %-12s\n" "ROLE" "MONTHLY" "SPENT" "%" "TODAY"
    printf -- '-%.0s' {1..70}; echo
    for r in $roles; do
      ensure_state "$r"
      monthly=$(role_field "$r" "monthly_limit_eur")
      spent=$(yq eval '.spent_eur // 0' "$(state_path "$r")")
      today_s=$(yq eval '.spent_today_eur // 0' "$(state_path "$r")")
      if [[ "$monthly" == "null" || "$monthly" == "0" ]]; then
        pct="—"; monthly_d="unset"
      else
        pct=$(awk -v s="$spent" -v m="$monthly" 'BEGIN{printf "%.0f%%", (s/m)*100}')
        monthly_d="€$monthly"
      fi
      printf "%-20s  %-12s  €%-11s  %-8s  €%-11s\n" "$r" "$monthly_d" "$spent" "$pct" "$today_s"
    done
    ;;
  set)
    require_config
    role="${1:?usage: set <role> --monthly-eur=<n> [--daily-eur=<n>]}"
    shift
    monthly=""; daily=""
    for arg in "$@"; do
      case "$arg" in
        --monthly-eur=*) monthly="${arg#--monthly-eur=}" ;;
        --daily-eur=*)   daily="${arg#--daily-eur=}" ;;
      esac
    done
    [[ -n "$monthly" || -n "$daily" ]] || {
      echo "at least one of --monthly-eur or --daily-eur required" >&2; exit 1
    }
    if [[ -n "$monthly" ]]; then
      is_number "$monthly" || { echo "--monthly-eur must be numeric" >&2; exit 1; }
      role="$role" yq eval -i ".budgets.per_role[strenv(role)].monthly_limit_eur = $monthly" "$CONFIG"
    fi
    if [[ -n "$daily" ]]; then
      is_number "$daily" || { echo "--daily-eur must be numeric" >&2; exit 1; }
      role="$role" yq eval -i ".budgets.per_role[strenv(role)].daily_limit_eur = $daily" "$CONFIG"
    fi
    jq -nc --arg role "$role" '{type:"budget.set", role:$role}'
    ;;
  check)
    require_config
    target="${1:---all}"
    if [[ "$target" == "--all" ]]; then roles=$(configured_roles); else roles="$target"; fi
    exit_code=0
    for r in $roles; do
      ensure_state "$r"
      monthly=$(role_field "$r" "monthly_limit_eur")
      if [[ "$monthly" == "null" || "$monthly" == "0" ]]; then
        echo "budget_unconfigured: $r (set monthly_limit_eur in $CONFIG)" >&2
        continue
      fi
      spent=$(yq eval '.spent_eur // 0' "$(state_path "$r")")
      ratio=$(awk -v s="$spent" -v m="$monthly" 'BEGIN{print s/m}')
      match=$(role="$r" yq eval -o=json ".budgets.per_role[strenv(role)].thresholds // []" "$CONFIG" \
        | jq -c --argjson ratio "$ratio" '
            [.[] | select((.at | tonumber) <= $ratio)]
            | sort_by(.at | tonumber) | last // {}
          ')
      mode=$(echo "$match" | jq -r '.mode // ""')
      pct=$(awk -v r="$ratio" 'BEGIN{printf "%.1f%%", r*100}')
      case "$mode" in
        warn)
          echo "budget_warn: $r at $pct" >&2 ;;
        throttle)
          secs=$(echo "$match" | jq -r '.throttle_seconds // 30')
          echo "budget_throttle: $r at $pct, sleeping ${secs}s" >&2
          sleep "$secs" ;;
        block)
          echo "budget_block: $r at $pct" >&2
          exit_code=2 ;;
        escalate)
          jq -n --arg ts "$(date -Is)" --arg role "$r" --argjson ratio "$ratio" \
            '{ts:$ts, type:"escalation.requested", role:$role, ratio:$ratio}' >> "$LEDGER"
          echo "budget_escalate: $r at $pct" >&2
          exit_code=3 ;;
        "")
          ;;  # no threshold matched
        *)
          echo "budget: unknown mode '$mode' for $r — treating as warn" >&2 ;;
      esac
    done
    exit $exit_code
    ;;
  record)
    require_config
    role="${1:?usage: record <role> <cost_eur> [--tokens-in=N --tokens-out=N]}"
    cost="${2:?cost_eur required}"
    shift 2
    is_number "$cost" || { echo "cost_eur must be numeric" >&2; exit 1; }
    tokens_in="null"; tokens_out="null"
    for arg in "$@"; do
      case "$arg" in
        --tokens-in=*)
          tokens_in="${arg#--tokens-in=}"
          is_number "$tokens_in" || { echo "--tokens-in must be numeric" >&2; exit 1; } ;;
        --tokens-out=*)
          tokens_out="${arg#--tokens-out=}"
          is_number "$tokens_out" || { echo "--tokens-out must be numeric" >&2; exit 1; } ;;
      esac
    done
    ensure_state "$role"
    sp=$(state_path "$role")
    now=$(date -Is); today_v=$(today_str)
    stored_day=$(yq eval '.last_event_date // ""' "$sp")
    if [[ "$stored_day" != "$today_v" ]]; then
      day="$today_v" yq eval -i '.spent_today_eur = 0 | .last_event_date = strenv(day)' "$sp"
    fi
    ts="$now" yq eval -i "
      .spent_eur = ((.spent_eur // 0) + $cost) |
      .spent_today_eur = ((.spent_today_eur // 0) + $cost) |
      .last_event_at = strenv(ts)
    " "$sp"
    jq -n --arg ts "$now" --arg role "$role" --argjson cost "$cost" \
          --argjson ti "$tokens_in" --argjson to "$tokens_out" \
      '{ts:$ts, type:"cost.recorded", role:$role, cost_eur:$cost, tokens_in:$ti, tokens_out:$to}' \
      >> "$LEDGER"
    jq -nc --arg role "$role" --argjson cost "$cost" '{type:"budget.record", role:$role, cost_eur:$cost}'
    ;;
  reset)
    role="${1:?usage: reset <role>}"
    sp=$(state_path "$role")
    [[ -f "$sp" ]] || { echo "no state for $role" >&2; exit 1; }
    cur=$(current_period)
    period="$cur" yq eval -i '.period = strenv(period) | .spent_eur = 0 | .spent_today_eur = 0' "$sp"
    jq -nc --arg role "$role" '{type:"budget.reset", role:$role}'
    ;;
  help|*)
    cat <<'USAGE'
Usage:
  budget.sh show [<role>]                               Table of budget state
  budget.sh set <role> --monthly-eur=N [--daily-eur=N]  Set caps in config
  budget.sh check [<role>|--all]                        Evaluate enforcement (exit 0=ok, 2=block, 3=escalate)
  budget.sh record <role> <cost_eur> [--tokens-in=N --tokens-out=N]
  budget.sh reset <role>                                Zero current-period counters
USAGE
    ;;
esac
