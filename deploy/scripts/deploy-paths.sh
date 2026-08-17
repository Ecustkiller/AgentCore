#!/usr/bin/env bash
# 活栈 compose 目录 + production.env 解析（backup.sh / restore.sh / deploy-server.sh 共用）。
#
# 被 source，不要直接执行。调用方先 set -euo pipefail。
#
# 解析顺序：
#   1. AGENTCORE_HOME（默认 /opt/agentcore）
#   2. source $AGENTCORE_HOME/.env（运维级变量；set -a，已导出的同名变量会被覆盖）
#   3. REPO_DIR（默认 $AGENTCORE_HOME/repo）
#   4. DEPLOY_DIR = AGENTCORE_DEPLOY_DIR，缺省 $REPO_DIR/deploy
#   5. ENV_FILE：已设置则保留；否则 ENVF（finish-server / mjs 约定）；否则 $DEPLOY_DIR/config/production.env
#
# deploy-server.sh 的 compose 文件路径仍用 $REPO_DIR/deploy（调用方/checkout 树），
# 本片段只收口「活栈目录 + env 文件」，不改它的 compose 文件选取。

AGENTCORE_HOME="${AGENTCORE_HOME:-/opt/agentcore}"
if [[ -f "$AGENTCORE_HOME/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$AGENTCORE_HOME/.env"
  set +a
fi
REPO_DIR="${REPO_DIR:-$AGENTCORE_HOME/repo}"
DEPLOY_DIR="${AGENTCORE_DEPLOY_DIR:-$REPO_DIR/deploy}"
if [[ -z "${ENV_FILE:-}" ]]; then
  ENV_FILE="${ENVF:-$DEPLOY_DIR/config/production.env}"
fi
