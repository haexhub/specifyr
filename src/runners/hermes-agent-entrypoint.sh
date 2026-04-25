#!/bin/sh
# hermes-agent container entrypoint.
#
# Reads BINARY_WHITELIST (comma-separated catalog binary IDs) and exposes
# only those binaries on PATH by symlinking from /opt/catalog/bin/<id> to
# /usr/local/bin/<id>. Catalog binaries that are NOT whitelisted simply
# do not exist on PATH inside the running container — attempts to invoke
# them will fail with "command not found".
#
# Base shell utilities (bash, sh, cat, ls, …) live in /bin and /usr/bin
# and are always available; they are not catalog binaries.
#
# After whitelisting, exec's the configured CMD (default: `hermes chat -q`).

set -eu

CATALOG_BIN_DIR="/opt/catalog/bin"
EXPOSE_DIR="/usr/local/bin"
WHITELIST="${BINARY_WHITELIST:-}"

# Split BINARY_WHITELIST on commas, trim whitespace, expose each entry that
# exists in the catalog. Unknown IDs cause a hard failure — silent ignore
# would mask config drift between catalog/binaries/ and runtime invocations.
if [ -n "$WHITELIST" ]; then
  OLD_IFS="$IFS"
  IFS=','
  for raw in $WHITELIST; do
    bin="$(printf '%s' "$raw" | tr -d '[:space:]')"
    [ -z "$bin" ] && continue

    src="${CATALOG_BIN_DIR}/${bin}"
    if [ ! -x "$src" ]; then
      printf >&2 'hermes-agent-entrypoint: unknown binary in BINARY_WHITELIST: %s (not in %s)\n' "$bin" "$CATALOG_BIN_DIR"
      exit 64
    fi

    ln -sf "$src" "${EXPOSE_DIR}/${bin}"
  done
  IFS="$OLD_IFS"
fi

exec "$@"
