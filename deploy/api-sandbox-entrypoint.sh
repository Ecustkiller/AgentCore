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
  # setpriv 不改环境：不重置 HOME 的话仍是 /root，asyncpg/libpq 会去读
  # /root/.postgresql/postgresql.key → uid app 得到 PermissionError，/readyz 判库挂。
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
