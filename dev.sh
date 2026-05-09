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
echo "🌐 Dev server available at: http://localhost:4242"
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