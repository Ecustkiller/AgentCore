# AgentCore

面向大众的 Multi-Agent AI 工作台——真正的 Agent 团队协作，而非「单 Agent + 子任务派发」。

> A multi-agent AI workspace built around real agent-team collaboration.

官网：[fashitianxia.xyz](https://fashitianxia.xyz)

## 仓库结构

| 路径 | 说明 |
|------|------|
| `apps/server` | FastAPI 后端 · runtime 执行引擎 · LLM 网关 |
| `apps/desktop` | Electron + React 桌面客户端 |
| `apps/mobile` | 移动端 |
| `apps/admin` | 管理后台 |
| `apps/town` | AI 小镇（Unity / AgentTown） |
| `apps/website` | 官网 |
| `packages/` | 跨端共享契约与工具包 |

更细的目录说明见 [`docs/02-架构/项目结构.md`](docs/02-架构/项目结构.md)。

## 快速开始

完整步骤见 **[`docs/02-架构/本地开发.md`](docs/02-架构/本地开发.md)**。

前置环境（与根 `package.json` `engines` / `packageManager` 对齐）：

- Node.js **22+**
- pnpm **10**（仓库锁定 `pnpm@10.28.1`）
- Python **3.12+**
- [uv](https://docs.astral.sh/uv/)
- Docker & Docker Compose

最短路径概览：

```bash
# 1. 基础设施
docker compose -f deploy/docker-compose.dev.yml up -d

# 2. 依赖
pnpm install
cd apps/server && uv sync && cd ../..

# 3. 按本地开发文档启动后端与桌面端
```

## 许可证与第三方资产

本仓库代码以 [Apache License 2.0](LICENSE) 授权。

第三方 3D 资产致谢与再分发约束见 [`NOTICE`](NOTICE)（含 Mixamo Xbot 风险说明——**非 CC0**，再分发前请自行核验）。

## 安全

发现安全漏洞请按 [`SECURITY.md`](SECURITY.md) 私下披露，**不要**在公开 Issue 中粘贴密钥或敏感信息。

## 贡献

欢迎提 Issue / Pull Request。贡献约定见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；完整 CONTRIBUTING 指南后续补充。
