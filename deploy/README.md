# `deploy/`

生产拓扑与机上文件。凭据只读 `deploy/.env.deploy.local`（不入仓）。

本机门禁 / 发版编排 → [仓根 `scripts/`](../scripts/README.md)。  
SSH / CDN / 探活脚本清单 → [`scripts/README.md`](./scripts/README.md)。

| 位置 | 用途 |
|------|------|
| `docker-compose.server.yml` · `app.yml` · `dev.yml` · `sandbox.yml` | 后端 / app 反代 / 本机 / gVisor 沙箱 |
| `nginx/` | `app-web`（产品同源）、`office-admin`、`downloads`（安装包 CDN） |
| `systemd/` | 现行：`agentcore-backup` · `agentcore-healthcheck`（timer + oneshot） |
| `searxng/` | 搜索后端配置 |
| `config/` | `production.env.example`（机上复制后人工维护，git pull 不覆盖） |
| `sandboxd-entrypoint.sh` | sandbox 容器入口 |
| `scripts/` | 真正动生产的脚本 |

拓扑与切流时序 → [部署拓扑与环境](../docs/05-平台与运维/部署拓扑与环境.md)。
