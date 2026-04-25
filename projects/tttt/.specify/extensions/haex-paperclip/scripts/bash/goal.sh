#!/usr/bin/env bash
# goal.sh — Paperclip goal management.
# Called by /speckit.haex-paperclip.goal.
set -euo pipefail

EXT_DIR="${SPECKIT_HAEX_PAPERCLIP_DIR:-.specify/extensions/haex-paperclip}"
GOALS_DIR="$EXT_DIR/goals"
MIRROR_DIR=".specify/goals"
mkdir -p "$GOALS_DIR" "$MIRROR_DIR"

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' \
    | cut -c1-64
}

emit_event() {
  local slug="$1" type="$2"
  jq -n --arg ts "$(date -Is)" --arg type "$type" --arg slug "$slug" \
    '{ts:$ts, type:$type, slug:$slug}' >> "$GOALS_DIR/$slug/events.jsonl"
}

cmd="${1:-help}"; shift || true

case "$cmd" in
  new)
    desc="${1:?usage: new \"<description>\"}"
    slug=$(slugify "$desc")
    [[ -n "$slug" ]] || { echo "description produced empty slug" >&2; exit 1; }
    dir="$GOALS_DIR/$slug"
    [[ ! -d "$dir" ]] || { echo "goal already exists: $slug" >&2; exit 1; }
    mkdir -p "$dir" "$MIRROR_DIR/$slug"
    created=$(date -Is)
    slug="$slug" desc="$desc" created="$created" yq eval -n '
      .slug = strenv(slug) |
      .title = strenv(desc) |
      .description = strenv(desc) |
      .status = "active" |
      .created_at = strenv(created) |
      .owner_role = null
    ' > "$dir/goal.yml"
    echo "specs: []" > "$dir/specs.yml"
    : > "$dir/events.jsonl"
    emit_event "$slug" "goal.new"
    cat > "$MIRROR_DIR/$slug/goal.md" <<EOF
# $desc

- slug: \`$slug\`
- status: active
- created: $created
EOF
    jq -nc --arg slug "$slug" '{type:"goal.new", slug:$slug, status:"active"}'
    ;;
  list)
    [[ -d "$GOALS_DIR" ]] || { echo "[]"; exit 0; }
    find "$GOALS_DIR" -mindepth 2 -maxdepth 2 -name goal.yml -type f \
      | while read -r f; do yq eval -o=json "$f"; done \
      | jq -s 'map({slug, title, status, created_at})'
    ;;
  show)
    slug="${1:?usage: show <slug>}"
    f="$GOALS_DIR/$slug/goal.yml"
    [[ -f "$f" ]] || { echo "no such goal: $slug" >&2; exit 1; }
    cat "$f"
    ;;
  link)
    slug="${1:?usage: link <slug> <spec-slug>}"
    spec="${2:?usage: link <slug> <spec-slug>}"
    sf="$GOALS_DIR/$slug/specs.yml"
    [[ -f "$sf" ]] || { echo "no such goal: $slug" >&2; exit 1; }
    spec="$spec" yq eval -i '.specs += [strenv(spec)]' "$sf"
    emit_event "$slug" "goal.link"
    jq -nc --arg slug "$slug" --arg spec "$spec" '{type:"goal.link", slug:$slug, spec:$spec}'
    ;;
  status)
    slug="${1:?usage: status <slug> <active|paused|done>}"
    new_status="${2:?usage: status <slug> <active|paused|done>}"
    case "$new_status" in active|paused|done) ;;
      *) echo "invalid status: $new_status (expected active|paused|done)" >&2; exit 1 ;;
    esac
    f="$GOALS_DIR/$slug/goal.yml"
    [[ -f "$f" ]] || { echo "no such goal: $slug" >&2; exit 1; }
    status="$new_status" yq eval -i '.status = strenv(status)' "$f"
    emit_event "$slug" "goal.status"
    jq -nc --arg slug "$slug" --arg s "$new_status" '{type:"goal.status", slug:$slug, status:$s}'
    ;;
  help|*)
    cat <<'USAGE'
Usage:
  goal.sh new "<description>"                     Create a new goal
  goal.sh list                                    List all goals (JSON array)
  goal.sh show <slug>                             Print a goal's YAML record
  goal.sh link <slug> <spec-slug>                 Attach a spec to a goal
  goal.sh status <slug> <active|paused|done>      Change a goal's status
USAGE
    ;;
esac
