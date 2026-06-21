#!/usr/bin/env bash
# 生产机收尾上线：切 IMAGE_TAG → 拉镜像 → 迁移 → 起 api → 健康检查。
# 供 deploy-backend.yml SSH 调用；与 /opt/agentcore/finish.sh 同路径约定。
# VPC ACR 的 short-sha tag 可能晚于公网端点同步，拉不到时回退 latest 并本地打 tag。
set -euo pipefail

DEPLOY="${AGENTCORE_DEPLOY_DIR:-/opt/agentcore/repo/deploy_f6d1637}"
ENVF="$DEPLOY/config/production.env"
ROOT_ENV="${AGENTCORE_HOME:-/opt/agentcore}/.env"
TAG="${1:?usage: finish-server.sh <short-sha|latest>}"

[[ -f "$ENVF" ]] || { echo "ERROR: $ENVF 不存在"; exit 1; }

echo "== [1/7] 切 IMAGE_TAG -> $TAG =="
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$TAG/" "$ENVF"
export IMAGE_TAG="$TAG"
export IMAGE_REGISTRY="$(grep -E '^IMAGE_REGISTRY=' "$ENVF" | head -1 | cut -d= -f2-)"
echo "registry=$IMAGE_REGISTRY tag=$IMAGE_TAG"

echo "== [2/7] 登录 ACR(VPC) =="
ACR_USER="$(grep -E '^ACR_USERNAME=' "$ROOT_ENV" | head -1 | cut -d= -f2-)"
ACR_PASS="$(grep -E '^ACR_PASSWORD=' "$ROOT_ENV" | head -1 | cut -d= -f2-)"
ACR_HOST="$(grep -E '^ACR_REGISTRY=' "$ROOT_ENV" | head -1 | cut -d= -f2-)"
echo "$ACR_PASS" | docker login "$ACR_HOST" -u "$ACR_USER" --password-stdin

IMAGE="${IMAGE_REGISTRY}/api:${IMAGE_TAG}"
echo "== [3/7] 拉 api 镜像 ($IMAGE) =="
if ! docker pull "$IMAGE" 2>/dev/null; then
  echo "WARN: tag $IMAGE_TAG 在 VPC 不可用，回退 latest 并本地打 tag"
  docker pull "${IMAGE_REGISTRY}/api:latest"
  docker tag "${IMAGE_REGISTRY}/api:latest" "$IMAGE"
fi

COMPOSE=( docker compose -p agentcore -f "$DEPLOY/docker-compose.server.yml" -f "$DEPLOY/docker-compose.app.yml" --env-file "$ENVF" )

echo "== [4/7] 确认基础设施在线 + 等 postgres =="
"${COMPOSE[@]}" up -d postgres redis searxng
for i in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T postgres pg_isready -U agentcore >/dev/null 2>&1 && break
  [[ $i -eq 30 ]] && { echo "ERROR: postgres 未就绪"; exit 1; }
  sleep 2
done
echo "postgres ready"

echo "== [5/7] alembic upgrade head =="
"${COMPOSE[@]}" run --rm api alembic upgrade head

echo "== [6/7] 起 api =="
"${COMPOSE[@]}" up -d

echo "== [7/7] 健康检查 /readyz =="
ok=0
for i in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8000/readyz || true)"
  [[ "$code" = "200" ]] && { ok=1; break; }
  sleep 3
done
if [[ "$ok" != "1" ]]; then
  echo "ERROR: /readyz 未健康"
  "${COMPOSE[@]}" logs --tail 80 api
  exit 1
fi
echo "READYZ OK"
echo "--- /version ---"
curl -s http://127.0.0.1:8000/version
echo
echo "FINISH DONE ✓"
