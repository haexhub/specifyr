#!/bin/sh
#
# Stub for the `claude` CLI used by api.e2e.test.ts. Mimics the
# `auth login --claudeai` flow:
#   - prints the URL we expect the driver to parse
#   - reads a code from stdin
#   - writes a fake .credentials.json under $HOME/.claude/
#   - exits 0
#
# Behaviour for other args mirrors the real CLI's "unknown command"
# response so unit tests that run a real binary (skipped here) would
# at least see a non-zero exit.
set -e

if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=fake-state&code_challenge=fake&code_challenge_method=S256"
  printf "Paste code here if prompted > "
  read CODE

  # Reject obviously-bad codes so the "submitCode rejects on bad
  # code" test path is exercisable without involving real OAuth.
  if [ "$CODE" = "BAD" ]; then
    echo "invalid code" >&2
    exit 1
  fi

  mkdir -p "$HOME/.claude"
  EXP_MS=$(node -e 'process.stdout.write(String(Date.now() + 3600000))')
  cat > "$HOME/.claude/.credentials.json" <<EOF
{"claudeAiOauth":{"accessToken":"fake-${CODE}","refreshToken":"fake-refresh","expiresAt":${EXP_MS},"scopes":["user:inference"]}}
EOF
  exit 0
fi

echo "fake-claude: unsupported args: $*" >&2
exit 1
