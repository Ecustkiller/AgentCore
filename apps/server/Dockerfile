# AgentCore 后端镜像（部署与运维.md §三 / §7.1）。
# 多阶段：builder 用 uv 按 uv.lock 复现依赖到 venv；runtime 只带 venv + 源码，
# 非 root 运行。GIT_SHA / BUILT_AT 构建期注入并经 GET /version 暴露。
#
# 本地构建：
#   docker build -t agentcore-api \
#     --build-arg GIT_SHA="$(git rev-parse --short HEAD)" \
#     --build-arg BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" apps/server

# ---- builder：按 uv.lock 解析依赖到 /app/.venv ----
FROM python:3.12-slim AS builder

# 复用官方 uv 二进制（快、可复现）。
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app

# 先只拷锁文件 + 清单装依赖（缓存层，源码改动不失效）。
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# 再拷源码并安装项目自身（不含 dev 组：pytest/ruff 不进镜像）。
COPY agentcore ./agentcore
COPY alembic.ini ./
COPY scripts ./scripts
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ---- runtime：精简镜像，只带 venv + 源码 ----
FROM python:3.12-slim AS runtime

# 构建溯源：构建期钉入镜像 ENV，运行时经 GET /version 暴露（部署与运维.md §7.1）。
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV GIT_SHA=${GIT_SHA} \
    BUILT_AT=${BUILT_AT}

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# 非 root 运行 + 预建 /data 并归属 app：命名卷首次挂载会继承该归属，
# 避免非 root 进程写挂载点失败的经典坑（DATA_DIR=/data 写工作区/记忆/快照）。
RUN groupadd --system app \
    && useradd --system --gid app --no-create-home app \
    && mkdir -p /data \
    && chown app:app /data

COPY --from=builder --chown=app:app /app /app

USER app

EXPOSE 8000

# 存活探针：/livez 进程在即恒 200（部署与运维.md §7）。用 urllib 免装 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/livez', timeout=3).status==200 else 1)"]

# 默认启 API（python -m agentcore 从环境读 HOST/PORT/DEBUG；prod DEBUG=false →
# 单 uvicorn 进程、无 reload）。部署脚本以 `alembic upgrade head` 覆盖命令跑迁移。
CMD ["python", "-m", "agentcore"]
