#!/usr/bin/env bash
# Diagnose-Script für den lokalen specifyr Docker-Compose-Stack.
#
# Read-only: prüft die Failure-Modes, die wir schon einmal in freier Wildbahn
# hatten, und gibt für jeden gefundenen Defekt den Fix-Befehl aus. Wendet
# nichts selber an — Drop-DB / Force-Recreate sind zu invasiv, das soll der
# Mensch entscheiden.
#
# Verwendung:  ./scripts/dev-doctor.sh
#
# Geprüft wird, weil's einmal hier kaputt war:
#   1. Postgres erreichbar
#   2. `haex_claude_proxy` Rolle existiert und Passwort `devpw` funktioniert
#      (Init-Script läuft nur auf frischem Volume, fehlt sonst lautlos)
#   3. `specifyr` DB existiert + Anzahl applied migrations == Anzahl im journal
#      (DB-Drift z.B. nach Squash-Migration)
#   4. specifyr-dev Container läuft, CI=true gesetzt (pnpm 11 sonst exit 1)
#   5. haex-claude-proxy:dev Image enthält das DB-credential staging
#      (crypto.js — Pre-PR#3-Images haben das nicht und liefern leere
#      Antworten)
#   6. SPECIFYR_SECRET_KEY in beiden Containern identisch

set -u  # -e absichtlich nicht: ein fehlgeschlagener Check soll den Rest
        # weiterlaufen lassen, damit man die volle Übersicht kriegt.

red()    { printf '\033[31m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }

PASS=0
FAIL=0

check() {
  local name="$1"; shift
  printf '  %-45s ' "$name"
}
ok()   { green "OK"; echo; PASS=$((PASS+1)); }
warn() { yellow "WARN"; echo "  $*"; }
bad()  { red "FAIL"; echo "  $*"; FAIL=$((FAIL+1)); }

echo "[dev-doctor] specifyr local stack health check"
echo

# ---------------------------------------------------------------------------
# 1. Postgres erreichbar
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
JOURNAL_FILE="$REPO_ROOT/server/shared/database/migrations/meta/_journal.json"

POSTGRES_UP=0
check "postgres container running"
if docker ps --format '{{.Names}}' | grep -qx specifyr-postgres-dev; then
  POSTGRES_UP=1
  ok
else
  bad "specifyr-postgres-dev not running.  Fix:  docker compose up -d postgres"
  warn "Postgres ist down — DB-Checks (2-3) werden übersprungen."
fi

if [ "$POSTGRES_UP" -eq 1 ]; then
  check "postgres accepts connections"
  if docker exec specifyr-postgres-dev pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ok
  else
    bad "pg_isready failed.  Fix:  docker compose restart postgres"
  fi

  # ---------------------------------------------------------------------------
  # 2. haex_claude_proxy Rolle + Passwort
  # ---------------------------------------------------------------------------
  check "haex_claude_proxy role exists"
  ROLE_EXISTS=$(docker exec specifyr-postgres-dev psql -U postgres -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname='haex_claude_proxy'" 2>/dev/null)
  if [ "$ROLE_EXISTS" = "1" ]; then
    ok
  else
    bad "Role fehlt.  Fix: docker exec specifyr-postgres-dev psql -U postgres -c \"CREATE ROLE haex_claude_proxy LOGIN PASSWORD 'devpw'\""
  fi

  check "haex_claude_proxy auth (devpw)"
  # Login-Test mit dem dev-Passwort. PGPASSWORD nur für diesen Aufruf gesetzt.
  if docker exec -e PGPASSWORD=devpw specifyr-postgres-dev \
       psql -U haex_claude_proxy -d specifyr -tAc "SELECT 1" >/dev/null 2>&1; then
    ok
  else
    bad "Login als haex_claude_proxy/devpw failed.  Fix: docker exec specifyr-postgres-dev psql -U postgres -c \"ALTER ROLE haex_claude_proxy WITH LOGIN PASSWORD 'devpw'\" && docker restart claude-proxy"
  fi

  # ---------------------------------------------------------------------------
  # 3. specifyr DB + Migrations
  # ---------------------------------------------------------------------------
  check "specifyr database exists"
  DB_EXISTS=$(docker exec specifyr-postgres-dev psql -U postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='specifyr'" 2>/dev/null)
  if [ "$DB_EXISTS" = "1" ]; then
    ok
  else
    bad "DB fehlt.  Fix: docker exec specifyr-postgres-dev psql -U postgres -c \"CREATE DATABASE specifyr OWNER postgres\""
  fi

  if [ "$DB_EXISTS" = "1" ]; then
    check "drizzle migrations match journal"
    APPLIED=$(docker exec specifyr-postgres-dev psql -U postgres -d specifyr -tAc \
      "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo 0)
    JOURNAL=$(grep -c '"tag"' "$JOURNAL_FILE" 2>/dev/null || echo 0)
    if [ "$APPLIED" = "$JOURNAL" ] && [ "$APPLIED" -gt 0 ]; then
      ok
    elif [ "$APPLIED" -gt "$JOURNAL" ]; then
      bad "applied=$APPLIED > journal=$JOURNAL — sieht nach Pre-Squash-Drift aus. Daten weg?  Fix: drop + recreate specifyr DB, dann docker restart specifyr-dev (migrator legt frisch an)"
    else
      warn "applied=$APPLIED journal=$JOURNAL — vermutlich erster Start, beim nächsten Boot vom specifyr container laufen die Migrations"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 4. specifyr-dev container + env
# ---------------------------------------------------------------------------
check "specifyr-dev container running"
if docker ps --format '{{.Names}}' | grep -qx specifyr-dev; then
  ok
  # CI=true nur prüfen wenn der Container läuft (sonst gibt's keinen exec)
  check "CI=true in specifyr-dev env"
  if docker exec specifyr-dev sh -c 'test "$CI" = "true"' 2>/dev/null; then
    ok
  else
    bad "CI ist nicht 'true' — pnpm 11 wird beim modules-purge Prompt exit 1.  Fix: docker-compose.yml specifyr.environment.CI: \"true\" + docker compose up -d --force-recreate specifyr"
  fi
else
  bad "specifyr-dev down.  Logs: docker logs specifyr-dev | tail -50.  Restart: docker compose up -d specifyr"
fi

# ---------------------------------------------------------------------------
# 5. claude-proxy: läuft + neue Image-Variante (mit crypto.js)
# ---------------------------------------------------------------------------
check "claude-proxy container running"
if docker ps --format '{{.Names}}' | grep -qx claude-proxy; then
  ok

  check "proxy image has DB credential staging"
  # PR #3 fügt src/crypto.js hinzu und setzt CREDENTIALS_ROOT default auf
  # /run/credentials. Alte Images haben weder das eine noch das andere.
  if docker exec claude-proxy test -f /app/src/crypto.js 2>/dev/null; then
    ok
  else
    bad "Image ist pre-#3 (kein crypto.js).  Fix: cd ~/Projekte/haex-claude-proxy && docker build -t haex-claude-proxy:dev . && docker compose up -d --force-recreate claude-proxy"
  fi

  check "proxy CREDENTIALS_ROOT points at tmpfs"
  PROXY_ROOT=$(docker exec claude-proxy sh -c \
    'node -e "console.log(process.env.CREDENTIALS_ROOT||\"/run/credentials\")"' 2>/dev/null)
  if [ "$PROXY_ROOT" = "/run/credentials" ]; then
    ok
  else
    warn "CREDENTIALS_ROOT=$PROXY_ROOT (erwartet /run/credentials) — explizit überschrieben?"
  fi
else
  bad "claude-proxy down.  Logs: docker logs claude-proxy | tail -50"
fi

# ---------------------------------------------------------------------------
# 6. SPECIFYR_SECRET_KEY identisch in specifyr-dev + claude-proxy
# ---------------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -qx specifyr-dev \
   && docker ps --format '{{.Names}}' | grep -qx claude-proxy; then
  check "SPECIFYR_SECRET_KEY matches across containers"
  KEY_SPEC=$(docker exec specifyr-dev printenv SPECIFYR_SECRET_KEY 2>/dev/null)
  KEY_PROXY=$(docker exec claude-proxy printenv SPECIFYR_SECRET_KEY 2>/dev/null)
  if [ -n "$KEY_SPEC" ] && [ "$KEY_SPEC" = "$KEY_PROXY" ]; then
    ok
  elif [ -z "$KEY_SPEC" ] || [ -z "$KEY_PROXY" ]; then
    bad "Key unset in mindestens einem Container.  Fix: SPECIFYR_SECRET_KEY=\$(openssl rand -hex 32) in .env, dann docker compose up -d --force-recreate"
  else
    bad "Keys unterschiedlich → Proxy kann oauth_credentials_data nicht entschlüsseln.  Fix: .env-Wert anpassen + beide Container recreaten"
  fi
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAIL" -eq 0 ]; then
  green "all checks passed ($PASS)"; echo
  exit 0
else
  red "$FAIL check(s) failed, $PASS ok"; echo
  exit 1
fi
