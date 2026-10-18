#!/usr/bin/env bash
# Deploy script for Polymarket Bot VPS
# Usage: ./deploy.sh [prod|staging|no-domain] [project_dir]
#   project_dir defaults to current directory

set -euo pipefail

ENV="${1:-prod}"
PROJECT_DIR="${2:-$(pwd)}"
COMPOSE_FILES="-f docker-compose.yml"

case "$ENV" in
  prod)
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.prod.yml"
    ENV_FILE=".env.prod"
    DASHBOARD_URL="https://your-domain.com (proxied via Nginx)"
    ;;
  no-domain)
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.no-domain.yml"
    ENV_FILE=".env.prod"
    DASHBOARD_URL="http://YOUR_VPS_IP:3105 (direct access)"
    ;;
  staging)
    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.yml"
    ENV_FILE=".env.staging"
    DASHBOARD_URL="http://localhost:3105"
    ;;
  *)
    echo "Usage: $0 [prod|staging|no-domain]"
    exit 1
    ;;
esac

echo "=== Deploying $ENV environment ==="

# 1. Pull latest code
cd "$PROJECT_DIR"
git fetch origin
git reset --hard origin/master

# 2. Clean up problematic directories that break Docker build context
# (Docker reads all files before applying .dockerignore)
# Do this AFTER git operations since we need .git for fetch/reset
echo "Cleaning build context..."
rm -rf .cursor .vscode .hermes .kilo .git 2>/dev/null || true

# 3. Check env file exists
if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found. Copy from .env.prod.example and fill in secrets."
    exit 1
fi

# Fix permissions on env file (Docker needs to read it)
chmod 644 "$ENV_FILE" 2>/dev/null || true

# 4. Build images
echo "Building Docker images..."
docker compose $COMPOSE_FILES build --pull

# 5. Stop old containers (graceful)
echo "Stopping old containers..."
docker compose $COMPOSE_FILES down --timeout 30

# 6. Start new containers
echo "Starting new containers..."
docker compose $COMPOSE_FILES up -d

# 7. Health check
echo "Waiting for health check..."
sleep 10
for i in {1..12}; do
    if docker compose $COMPOSE_FILES ps --format json | grep -q '"Health":"healthy"'; then
        echo "✓ All services healthy"
        break
    fi
    echo "  Waiting... ($i/12)"
    sleep 5
done

# 8. Show status
docker compose $COMPOSE_FILES ps

echo "=== Deploy complete ==="
echo "Dashboard: $DASHBOARD_URL"
echo "Logs: docker compose $COMPOSE_FILES logs -f"