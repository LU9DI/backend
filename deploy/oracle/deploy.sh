#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/filtra-ai"
IMAGE_REPO="ghcr.io/lu9di/backend"
HEALTH_URL="http://127.0.0.1:5000/api/live"
NEW_TAG="${1:-latest}"
cd "$APP_DIR"
[[ -f .env ]] || { echo "ERROR: $APP_DIR/.env is missing"; exit 1; }
PREVIOUS_IMAGE="$(docker inspect --format="{{.Config.Image}}" filtra-ai-api 2>/dev/null || true)"

echo "[1/5] pulling $IMAGE_REPO:$NEW_TAG"
docker pull "$IMAGE_REPO:$NEW_TAG"
echo "[2/5] starting new container"
IMAGE_TAG="$NEW_TAG" docker compose up -d --no-deps filtra-api
echo "[3/5] waiting for health"
healthy=0
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 5
done
if [[ "$healthy" != "1" ]]; then
  echo "ERROR: new deployment did not become healthy"
  docker compose logs --tail=120 filtra-api || true
  if [[ -n "$PREVIOUS_IMAGE" ]]; then
    echo "[4/5] rolling back to $PREVIOUS_IMAGE"
    docker pull "$PREVIOUS_IMAGE" || true
    PREVIOUS_TAG="${PREVIOUS_IMAGE##*:}"
    IMAGE_TAG="$PREVIOUS_TAG" docker compose up -d --no-deps filtra-api || true
  fi
  exit 1
fi
echo "[4/5] healthy"
docker image prune -af --filter "until=168h" || true
echo "[5/5] deployment complete"
docker compose ps
