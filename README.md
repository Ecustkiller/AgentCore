# AgentCore

面向大众的 Multi-Agent AI 工作台。核心差异：真正的 Agent 团队协作，而非"单 Agent + 子任务派发"。

## 快速启动

### 前置要求

- Python 3.12+
- Node.js 20+
- pnpm 9+
- Docker & Docker Compose
- uv（Python 包管理器）

### 1. 启动本地基础设施

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

### 2. 启动后端

```bash
cd apps/server
cp .env.example .env  # 填写 DEEPSEEK_API_KEY 等
uv sync
uv run uvicorn agentcore.main:app --reload --port 8000
```

### 3. 启动前端

```bash
cd apps/desktop
pnpm install
pnpm dev
```

## 项目结构

```
AgentCore/
├── docs/                 # 设计文档
├── apps/
│   ├── server/           # Python 后端（FastAPI）
│   └── desktop/          # Electron + React 前端
├── packages/
│   └── scripts/          # 共享工具脚本
├── deploy/               # 部署配置
└── .github/workflows/    # CI/CD
```

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.12 / FastAPI / SQLAlchemy / Alembic |
| 前端 | Electron / React 19 / Zustand / Tailwind / shadcn/ui / React Flow |
| 存储 | PostgreSQL 16 + pgvector / Redis 7 |
| LLM | DeepSeek V4（Flash + Pro） |
| 部署 | Docker Compose / Nginx |

## 开发命令

```bash
# 后端
cd apps/server
uv run uvicorn agentcore.main:app --reload    # 开发服务器
uv run pytest                                  # 测试
uv run ruff check .                            # lint

# 前端
cd apps/desktop
pnpm dev                                       # electron-vite 开发模式
pnpm test                                      # Vitest
pnpm build                                     # 构建
```

## 文档

设计文档位于 `docs/` 目录，覆盖架构设计、接口定义、开发里程碑等。
