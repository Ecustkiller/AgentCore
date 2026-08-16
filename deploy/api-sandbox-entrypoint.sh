#!/bin/sh
# Sandbox overlay entrypoint (docker-compose.sandbox.yml).
#
# Starts as root (compose user: "0:0") only to:
#   1. make a container-private /run/netns mount (iproute2 requires a mountpoint);
#   2. chown it to app so uid 999 can create acbrw*/acpkg* inodes;
#   3. drop to USER app while keeping ambient NET_ADMIN+SYS_ADMIN;
#   4. reset HOME/USER so libpq does not read /root/.postgresql as uid app.
# The API / alembic / one-shot compose-run commands then run as app — not root,
# not privileged:true. Those two caps are what `ip netns` + veth and non-rootless
# `runsc --network=sandbox` (browser + package_install) need.
set -eu

if [ "$(id -u)" = "0" ]; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "api-sandbox-entrypoint: setpriv not found (util-linux); cannot drop to app" >&2
    exit 1
  fi
  mkdir -p /run/netns
  if ! grep -q ' /run/netns ' /proc/mounts; then
    mount --bind /run/netns /run/netns
  fi
  chown app:app /run/netns
  chmod 0755 /run/netns
  # setpriv 不改环境：compose user 0:0 会把 HOME 设成 /root。asyncpg 默认
  # ssl=prefer，按 Path.home() 读 ~/.postgresql/postgresql.key；uid app 读
  # 0600 root 私钥 → PermissionError → /readyz 误判库挂。
  # 私钥必须 app 可读且不过宽（0600；0644 会被 OpenSSL/libpq 拒绝）。
  mkdir -p /home/app
  if [ -d /root/.postgresql ]; then
    mkdir -p /home/app/.postgresql
    cp -a /root/.postgresql/. /home/app/.postgresql/
    chown -R app:app /home/app/.postgresql
    chmod 0700 /home/app/.postgresql
    find /home/app/.postgresql -type f -name '*.key' -exec chmod 0600 {} +
    find /home/app/.postgresql -type f ! -name '*.key' -exec chmod 0644 {} +
  fi
  chown app:app /home/app
  chmod 0700 /home/app
  # 即使 HOME 仍漏成 /root，uid app 也进不去（官方镜像 /root 常是 0755）。
  chmod 0700 /root 2>/dev/null || true
  export HOME=/home/app
  export USER=app
  export LOGNAME=app
  exec setpriv \
    --reuid=app \
    --regid=app \
    --init-groups \
    --inh-caps=+net_admin,+sys_admin \
    --ambient-caps=+net_admin,+sys_admin \
    -- "$@"
fi

exec "$@"
