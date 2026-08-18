#!/bin/bash
# AgentCore macOS 本地开发一键脚本（无 Docker 版）
#
# 背景：AgentCore 官方 dev 流程用 docker compose 起 Postgres/Redis/SearXNG。
# 本脚本为本机原生方案（用户硬性要求不用 Docker）：
#   - PostgreSQL 17 独立实例（端口 5433，数据目录 ~/.workbuddy/pg-agentcore）
#     · 项目迁移用 `NULLS NOT DISTINCT`（PG15+ 语法），本机旧版 PG14 跑不动
#     · 独立实例避免动本机 PG14 里的既有数据库
#   - Redis（6379，redis-server --daemonize）
#   - 后端（uv run python -m agentcore，默认 8000）+ alembic 迁移
#   - SearXNG 无 Docker 不启动，web_search 自动降级（可配 TAVILY_API_KEY）
#
# 用法（仓库根任意位置执行）：
#   apps/server/scripts/dev-no-docker.sh               # 启动（已在跑且健康则直接显示状态）
#   apps/server/scripts/dev-no-docker.sh --restart     # 强制重启后端（杀旧进程起新）
#   apps/server/scripts/dev-no-docker.sh --no-migrate  # 跳过迁移
#   apps/server/scripts/dev-no-docker.sh --port 8080   # 换端口
#   AGENTCORE_PGDATA=/your/path apps/server/scripts/dev-no-docker.sh  # 换 PG 数据目录
#
# 环境变量可覆盖：
#   AGENTCORE_PGDATA   PG17 数据目录（默认 ~/.workbuddy/pg-agentcore）
#   AGENTCORE_PGPORT   PG17 端口（默认 5433）
#   AGENTCORE_PG_BIN   PG17 bin 目录（默认 /opt/homebrew/opt/postgresql@17/bin，自动探测）
set -uo pipefail

# ---------- 配置 ----------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVER_ROOT="$REPO_ROOT/apps/server"
PORT="${PORT:-8000}"
MIGRATE=1
RESTART=0

for arg in "$@"; do
  case "$arg" in
    --no-migrate) MIGRATE=0 ;;
    --restart) RESTART=1 ;;
    --port=*) PORT="${arg#*=}" ;;
    --port) shift; PORT="$1" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -30
      exit 0 ;;
  esac
done

PGDATA="${AGENTCORE_PGDATA:-$HOME/.workbuddy/pg-agentcore}"
PGPORT="${AGENTCORE_PGPORT:-5433}"

if [ -d /opt/homebrew/opt/postgresql@17/bin ]; then
  PG_BIN=/opt/homebrew/opt/postgresql@17/bin
elif command -v pg_ctl >/dev/null && [ "$(pg_ctl --version 2>/dev/null | awk '{print $3}' | cut -d. -f1)" -ge 17 ]; then
  PG_BIN="$(dirname "$(command -v pg_ctl)")"
else
  echo "✗ 未找到 PostgreSQL 17。请先: brew install postgresql@17"; exit 1
fi

log()  { echo -e "\033[36m[dev]\033[0m $*"; }
ok()   { echo -e "\033[32m[ok] \033[0m $*"; }
warn() { echo -e "\033[33m[warn]\033[0m $*"; }
die()  { echo -e "\033[31m[err] \033[0m $*"; exit 1; }

# ---------- 0. 工具链检查 ----------
command -v uv >/dev/null || die "缺少 uv（brew install uv）"
command -v redis-cli >/dev/null || die "缺少 redis-cli（brew install redis）"

# ---------- 1. PostgreSQL 17 独立实例 ----------
ensure_pg17() {
  if "$PG_BIN/pg_isready" -h localhost -p "$PGPORT" -q 2>/dev/null; then
    ok "PostgreSQL 17 已在运行 (localhost:$PGPORT)"
    return
  fi
  if [ ! -d "$PGDATA/base" ]; then
    log "初始化 PG17 数据目录: $PGDATA"
    # keg-only 公式需补全局链接，否则 postgres 启动报 could not open directory
    if [ ! -e /opt/homebrew/lib/postgresql@17 ]; then
      CELLAR="$(brew --prefix postgresql@17 2>/dev/null || true)"
      CELLAR_LIB="$CELLAR/../../Cellar/postgresql@17/$(ls "$CELLAR/../../Cellar/postgresql@17" 2>/dev/null | head -1)/lib/postgresql"
      if [ -n "$CELLAR_LIB" ] && [ -d "$CELLAR_LIB" ]; then
        ln -sfn "$CELLAR_LIB" /opt/homebrew/lib/postgresql@17
        ln -sfn "$(dirname "$CELLAR_LIB")/share/postgresql" /opt/homebrew/share/postgresql@17 2>/dev/null || true
      fi
    fi
    mkdir -p "$PGDATA"
    TZ=UTC "$PG_BIN/initdb" -D "$PGDATA" -U agentcore --encoding=UTF8 --auth=trust \
      -L "$PG_BIN/../share/postgresql" >/dev/null 2>&1 \
      || die "initdb 失败，见上方输出"
  fi
  log "启动 PG17 (localhost:$PGPORT, $PGDATA)"
  "$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT" -l "$PGDATA/server.log" start >/dev/null 2>&1 \
    || die "pg_ctl 启动失败，见 $PGDATA/server.log"
  for _ in $(seq 1 15); do
    "$PG_BIN/pg_isready" -h localhost -p "$PGPORT" -q 2>/dev/null && break
    sleep 1
  done
  "$PG_BIN/pg_isready" -h localhost -p "$PGPORT" -q || die "PG17 未就绪"
  ok "PostgreSQL 17 就绪 (localhost:$PGPORT)"

  # 建库（幂等）
  "$PG_BIN/psql" -h localhost -p "$PGPORT" -U agentcore -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='agentcore'" | grep -q 1 \
    || "$PG_BIN/psql" -h localhost -p "$PGPORT" -U agentcore -d postgres -c "CREATE DATABASE agentcore OWNER agentcore" >/dev/null
  ok "数据库 agentcore 就绪"
}

# ---------- 2. Redis ----------
ensure_redis() {
  if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
    ok "Redis 已在运行 (127.0.0.1:6379)"
  else
    log "启动 Redis (--daemonize)"
    redis-server --daemonize yes >/dev/null 2>&1
    sleep 1
    redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG || die "Redis 启动失败"
    ok "Redis 就绪 (127.0.0.1:6379)"
  fi
}

# ---------- 3. .env ----------
ensure_env() {
  [ -f "$SERVER_ROOT/.env" ] && return
  log "生成 apps/server/.env（含随机 ENCRYPTION_KEY）"
  ENC_KEY="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  sed "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$ENC_KEY/" "$SERVER_ROOT/.env.example" > "$SERVER_ROOT/.env"
  # 指向本机 PG17 独立实例端口
  sed -i '' 's|postgresql+asyncpg://agentcore:agentcore@localhost:5432/agentcore|postgresql+asyncpg://agentcore@localhost:'"$PGPORT"'/agentcore|' "$SERVER_ROOT/.env"
  ok ".env 已生成"
}

# ---------- 4. 迁移 ----------
run_migrate() {
  [ "$MIGRATE" -eq 0 ] && { log "跳过迁移（--no-migrate）"; return; }
  log "执行数据库迁移 (alembic upgrade head)"
  ( cd "$SERVER_ROOT" && uv run alembic upgrade head ) || die "迁移失败"
  ok "迁移完成"
}

# ---------- 5. 后端 ----------
backend_running() {
  curl -s -m 2 "http://localhost:$PORT/readyz" 2>/dev/null | grep -q '"database":true'
}

start_backend() {
  if backend_running && [ "$RESTART" -eq 0 ]; then
    ok "后端已在运行并健康 (http://localhost:$PORT)"
    return
  fi
  if [ "$RESTART" -eq 1 ] || backend_running; then
    log "停止旧后端进程 (port $PORT)"
    # 用监听端口精确找 PID（避免 pkill -f 在部分环境误匹配到无关进程树）
    local pid
    pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
        sleep 1
      done
    fi
    sleep 1
  fi
  log "启动后端 (port $PORT)"
  ( cd "$SERVER_ROOT" && nohup uv run python -m agentcore > "$REPO_ROOT/logs/dev-server.log" 2>&1 & )
  for _ in $(seq 1 30); do
    backend_running && break
    sleep 1
  done
  backend_running || die "后端未就绪，日志: $REPO_ROOT/logs/dev-server.log"
  ok "后端就绪: http://localhost:$PORT  ($(curl -s -m 2 "http://localhost:$PORT/version" 2>/dev/null | head -c 80))"
}

# ---------- 执行 ----------
mkdir -p "$REPO_ROOT/logs"
ensure_pg17
ensure_redis
ensure_env
run_migrate
start_backend

echo
echo "  API:    http://localhost:$PORT/docs"
echo "  PG17:   localhost:$PGPORT (db=agentcore, user=agentcore, trust)"
echo "  Redis:  127.0.0.1:6379"
echo "  日志:   $REPO_ROOT/logs/dev-server.log"
echo
echo "  桌面端开发: cd $REPO_ROOT && pnpm -C apps/desktop dev"
