#!/usr/bin/env bash
#
# AgentCore 健康巡检 + 告警（部署与运维.md §7.8「可观测·巡检」）。
#
# 单次探测 /readyz：HTTP 200/503 **仅由 PostgreSQL 决定**（Redis 是限流软依赖，
# 不因 redis 失败回 503；详见 body 字段 / 日志 redis.probe_failed）。HTTP 非 200
# → 连续 N 次失败才告警（防抖）→ 恢复时补一条恢复通知。HTTP 200 但 body 含
# `"redis": false`、或 `disk.used_pct` 越过 DISK_WARN_PCT 时，各发一条软告警
# （不挡部署、不计入失败计数、边沿触发一次）。由 systemd timer（或 cron）每 1–2
# 分钟驱动一次；本脚本自身无状态循环，连续失败计数落 STATE_FILE 跨次累积。
#
# 告警出口是「可插拔 notifier」：配了 ALERT_WEBHOOK_URL（飞书群机器人）就推飞书，
# 没配就降级到 journald（stderr，systemd 自动收）+ 非零退出。换钉钉/换渠道只改
# URL，不改逻辑——呼应仓里 RateLimiter protocol 那种可注入缝的姿态。
#
# 用法：
#   healthcheck.sh                 # 一次探测（systemd timer / cron 反复调）
#
# 配置（可经环境或 $AGENTCORE_HOME/.env 覆盖，部署与运维.md §8.2）：
#   AGENTCORE_HOME     部署根目录                （默认 /opt/agentcore）
#   HEALTH_URL         探测地址                  （默认 http://127.0.0.1:8000/readyz）
#   HEALTH_TIMEOUT     单次探测超时(s)           （默认 10）
#   FAIL_THRESHOLD     连续失败几次才首次告警    （默认 3，防抖）
#   REALERT_EVERY      持续失败每隔几次再报一次  （默认 30，0=只报一次直到恢复）
#   STATE_FILE         连续失败计数文件          （默认 $AGENTCORE_HOME/.healthcheck.state）
#   DISK_WARN_PCT      磁盘水位软告警阈值(%)     （默认 80，与 observability/disk.py 同口径）
#   ALERT_WEBHOOK_URL  飞书群机器人 webhook      （未配则降级 journald）
#   ALERT_KEYWORD      告警前缀/飞书自定义关键词 （默认 AgentCore）

set -euo pipefail

# ── 配置 ──
AGENTCORE_HOME="${AGENTCORE_HOME:-/opt/agentcore}"
# 根 .env：ALERT_WEBHOOK_URL 等运维级变量（与 deploy-server.sh 同源约定）。
if [[ -f "$AGENTCORE_HOME/.env" ]]; then
  set -a; . "$AGENTCORE_HOME/.env"; set +a
fi
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/readyz}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-10}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
REALERT_EVERY="${REALERT_EVERY:-30}"
STATE_FILE="${STATE_FILE:-$AGENTCORE_HOME/.healthcheck.state}"
# 软依赖告警边沿状态（0=正常/未知，1=已报过）；各自独立，与 HTTP 失败计数分离
REDIS_STATE_FILE="${REDIS_STATE_FILE:-$AGENTCORE_HOME/.healthcheck.redis.state}"
DISK_STATE_FILE="${DISK_STATE_FILE:-$AGENTCORE_HOME/.healthcheck.disk.state}"
# 磁盘水位告警阈值（%）。与 server 端 observability/disk.py 的 HIGH_WATERMARK_PCT
# 同口径；那边写 jsonl 供事后巡检，这里负责当场推人。
DISK_WARN_PCT="${DISK_WARN_PCT:-80}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ALERT_KEYWORD="${ALERT_KEYWORD:-AgentCore}"

HOST="$(hostname 2>/dev/null || echo unknown)"
NOW="$(date '+%Y-%m-%d %H:%M:%S %z')"

log()  { printf '[healthcheck] %s\n' "$*"; }
warn() { printf '[healthcheck][warn] %s\n' "$*" >&2; }
err()  { printf '[healthcheck][error] %s\n' "$*" >&2; }

# ── notifier：飞书 webhook，失败/未配则回落 journald ──
json_escape() {  # 转义 JSON 字符串内的 \ 与 "（消息保持单行，无需处理换行）
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

send_alert() {  # $1=正文；前缀 keyword 既作标识也满足飞书「自定义关键词」安全模式
  local body="$1"
  local text="[$ALERT_KEYWORD] $body · host=$HOST · $NOW"
  if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
    err "$text （未配 ALERT_WEBHOOK_URL，降级 journald）"
    return 0
  fi
  local payload="{\"msg_type\":\"text\",\"content\":{\"text\":\"$(json_escape "$text")\"}}"
  if curl -fsS -m "$HEALTH_TIMEOUT" -X POST \
      -H 'Content-Type: application/json' \
      -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1; then
    log "alert pushed: $body"
  else
    err "$text （飞书推送失败，降级 journald）"
  fi
}

# ── 读跨次连续失败计数 ──
prev=0
if [[ -f "$STATE_FILE" ]]; then
  prev="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
  [[ "$prev" =~ ^[0-9]+$ ]] || prev=0
fi
write_state() {  # 写计数；状态目录不可写则仅告警（防抖退化为每次都报，可接受）
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
  if ! printf '%s' "$1" >"$STATE_FILE" 2>/dev/null; then
    warn "无法写状态文件 $STATE_FILE，防抖计数将不跨次累积"
  fi
}

read_edge_state() {  # $1=state file；只认 0/1，其余当 0（未报过）
  local v=0
  if [[ -f "$1" ]]; then
    v="$(cat "$1" 2>/dev/null || echo 0)"
    [[ "$v" =~ ^[01]$ ]] || v=0
  fi
  printf '%s' "$v"
}
write_edge_state() {  # $1=state file, $2=0|1
  mkdir -p "$(dirname "$1")" 2>/dev/null || true
  printf '%s' "$2" >"$1" 2>/dev/null || true
}

# ── 单次探测：仅 HTTP 200 视为健康（DB ready）。curl 的 %{http_code} 在连接失败
#    时本身就输出 000，故不能再 `|| echo 000`（会拼成 000000）；用 `|| true` 仅
#    吞掉非零退出。同时抓 body，便于 Redis 软依赖观测告警。──
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
code="$(curl -s -o "$body_file" -w '%{http_code}' -m "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>/dev/null)" || true
code="${code:-000}"

if [[ "$code" == "200" ]]; then
  if (( prev >= FAIL_THRESHOLD )); then
    send_alert "✅ 已恢复：$HEALTH_URL 200（此前连续失败 ${prev} 次）"
  fi
  write_state 0
  # Redis 软依赖：HTTP 仍健康；body redis=false 时边沿告警一次（不 exit 1、不挡部署）
  redis_prev="$(read_edge_state "$REDIS_STATE_FILE")"
  if grep -Eq '"redis"[[:space:]]*:[[:space:]]*false' "$body_file" 2>/dev/null; then
    if [[ "$redis_prev" != "1" ]]; then
      send_alert "⚠️ Redis 软依赖异常：$HEALTH_URL 200 但 body redis=false（限流可降级；见日志 redis.probe_failed）"
      write_edge_state "$REDIS_STATE_FILE" 1
    fi
    warn "redis soft-dep unhealthy: $HEALTH_URL 200 redis=false"
  else
    if [[ "$redis_prev" == "1" ]]; then
      send_alert "✅ Redis 软依赖已恢复：$HEALTH_URL body redis 不再为 false"
      write_edge_state "$REDIS_STATE_FILE" 0
    fi
    log "healthy: $HEALTH_URL 200"
  fi

  # 磁盘水位：同样是观测字段（/readyz 200/503 只看 Postgres），但盘满会让 Postgres
  # checkpoint 写不出去 → PANIC 恢复循环（2026-08-17 线上全挂即此形态）。所以在还只是
  # 高水位时就推人，是这条分支存在的唯一理由。used_pct 为 null（探测失败）时不报——
  # server 端已写 disk.probe_failed，这里再报一次只是噪音。
  disk_pct="$(sed -n 's/.*"disk"[[:space:]]*:[[:space:]]*{[^}]*"used_pct"[[:space:]]*:[[:space:]]*\([0-9.]\{1,\}\).*/\1/p' \
    "$body_file" 2>/dev/null | head -1)"
  disk_prev="$(read_edge_state "$DISK_STATE_FILE")"
  if [[ -n "$disk_pct" ]] \
    && awk -v p="$disk_pct" -v t="$DISK_WARN_PCT" 'BEGIN { exit !(p + 0 >= t + 0) }'; then
    if [[ "$disk_prev" != "1" ]]; then
      send_alert "⚠️ 磁盘水位 ${disk_pct}% ≥ ${DISK_WARN_PCT}%：$HEALTH_URL 仍 200，但盘满会让 Postgres/Redis 写失败（清理或扩容）"
      write_edge_state "$DISK_STATE_FILE" 1
    fi
    warn "disk watermark high: ${disk_pct}% >= ${DISK_WARN_PCT}%"
  elif [[ -n "$disk_pct" && "$disk_prev" == "1" ]]; then
    send_alert "✅ 磁盘水位已回落：${disk_pct}% < ${DISK_WARN_PCT}%"
    write_edge_state "$DISK_STATE_FILE" 0
  fi
  exit 0
fi

# ── 不健康：累加计数，按阈值/重报间隔决定是否告警，非零退出让 systemctl status 标红 ──
count=$(( prev + 1 ))
write_state "$count"
reason="HTTP ${code}"
[[ "$code" == "000" ]] && reason="不可达（连接失败/超时）"

if (( count == FAIL_THRESHOLD )); then
  send_alert "🔴 服务异常：$HEALTH_URL $reason（连续 ${count} 次，达告警阈值）"
elif (( count > FAIL_THRESHOLD && REALERT_EVERY > 0 )) && (( (count - FAIL_THRESHOLD) % REALERT_EVERY == 0 )); then
  send_alert "🔴 服务仍异常：$HEALTH_URL $reason（已连续 ${count} 次）"
else
  warn "probe failed: $HEALTH_URL $reason（连续 ${count}/${FAIL_THRESHOLD} 次，未达告警阈值）"
fi
exit 1
