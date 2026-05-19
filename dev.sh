#!/bin/bash

# Development script for specifyr with Docker
# Starts the dev container with source mounting for HMR and debugging

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "🚀 Starting specifyr development environment..."
echo "📁 Project root: $PROJECT_ROOT"
echo "🐳 Building and starting containers..."

# Set UID/GID for proper file permissions
export USER_UID=$(id -u)
export USER_GID=$(id -g)

# Host-Port-Schema: alle Services ab PORT_BASE (Default 10000), Traefik bleibt
# auf 80. Compose-Interpolation kann keine Arithmetik, deshalb leiten wir hier
# die per-service-Vars aus PORT_BASE ab. Per-service-Override hat Vorrang.
PORT_BASE=${PORT_BASE:-10000}

# Range-Check: non-numeric oder out-of-range -> fail-fast statt silent kaputter
# Bindings. Obergrenze 60000 lässt Headroom für PORT_BASE+4 (max valid: 65535);
# Untergrenze 1024 vermeidet privilegierte Ports.
if ! [[ "$PORT_BASE" =~ ^[0-9]+$ ]] || [ "$PORT_BASE" -lt 1024 ] || [ "$PORT_BASE" -gt 60000 ]; then
    echo "❌ PORT_BASE='$PORT_BASE' invalid — must be an integer between 1024 and 60000" >&2
    exit 1
fi

export SPECIFYR_PORT=${SPECIFYR_PORT:-$PORT_BASE}
export POSTGRES_PORT=${POSTGRES_PORT:-$((PORT_BASE + 1))}
export AUTHENTIK_HTTP_PORT=${AUTHENTIK_HTTP_PORT:-$((PORT_BASE + 2))}
export AUTHENTIK_HTTPS_PORT=${AUTHENTIK_HTTPS_PORT:-$((PORT_BASE + 3))}
export TRAEFIK_DASHBOARD_PORT=${TRAEFIK_DASHBOARD_PORT:-$((PORT_BASE + 4))}

# Set DOCKER_GID if docker group exists
if getent group docker >/dev/null 2>&1; then
    export DOCKER_GID=$(getent group docker | cut -d: -f3)
    echo "🐳 Docker group GID: $DOCKER_GID"
else
    echo "⚠️  Docker group not found, using default GID 999"
    export DOCKER_GID=999
fi

# Build and start containers
docker compose up --build -d

echo "✅ Containers started!"
echo "🌐 Dev server available at: http://localhost:${SPECIFYR_PORT}"
echo ""
echo "📋 Useful commands:"
echo "  • View logs: docker compose logs -f"
echo "  • Shell access: docker compose exec specifyr sh"
echo "  • Stop: docker compose down"
echo "  • Restart: docker compose restart"
echo ""
echo "🔍 For debugging:"
echo "  • Container logs: docker compose logs specifyr"
echo "  • Check processes: docker compose exec specifyr ps aux"
echo "  • View pnpm dev output: docker compose logs -f specifyr"
echo ""
echo "💡 The source code is mounted with HMR enabled."
echo "   Edit files locally and see changes instantly in the browser."