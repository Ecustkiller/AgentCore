# AgentCore 管理后台 (apps/admin)

平台运营者的**独立 web 控制台**（React + Vite + Tailwind v4）。与桌面端解耦，单独部署、独立登录。

设计权威（形态决策、鉴权、模块范围、后端契约）→ [`docs/05-平台与运维/管理员后台.md`](../../docs/05-平台与运维/管理员后台.md)。  
部署 → [`部署与运维.md`](../../docs/05-平台与运维/部署与运维.md)。

## 本地开发

```bash
pnpm install        # 同时经 postinstall 从 ../server/openapi.json 生成 API 类型
pnpm dev            # http://localhost:5174
```

需要后端在 `http://localhost:8000` 运行（或用 `VITE_API_URL` 指定，见 `.env.example`）。

### 跨 origin 鉴权（CORS + Cookie）

控制台跑在 `:5174`、后端在 `:8000`——不同 origin 但同站（localhost），故：

- 后端须把本 origin 加入 `cors_allow_origins`（默认已含 `http://localhost:5174`），`allow_credentials=True`。
- 请求一律 `credentials: "include"`；cookie 为 `SameSite=Lax`（同站可跨 origin 携带）。
- 生产：控制台部署在**独立 origin**（可自托管；建议再加身份门），按需收紧 `COOKIE_SECURE` / `COOKIE_SAMESITE`。

## 类型

REST 类型从后端 OpenAPI 生成（单一真相源），勿手写。真源在仓库根：

```bash
# 在仓库根执行（会 dump OpenAPI + 生成 packages/contract-rest-types，并过契约门禁）
pnpm gen:types
```

`apps/admin/src/types/api.generated.ts` 只是对 `@agentcore/contract-rest-types` 的透传，admin 包内没有独立的 `gen:api`。改 schema 后务必走根 `pnpm gen:types`，不要在 admin 目录本地另生成。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发服务器（5174）|
| `pnpm build` | 类型检查 + 生产构建 |
| `pnpm typecheck` | 仅 `tsc --noEmit` |
| `pnpm test` | vitest（jsdom 渲染测试）|
| （仓库根）`pnpm gen:types` | 重生成契约类型（含 admin 透传源） |

## 界面约定

控制台是**亮色单主题**：`src/styles/globals.css` 只有 `:root` 一套 OKLCH token，色相与
`packages/design-tokens` 同源，但不镜像它的暗色半（运营控制台只在桌面浏览器打开，不值得
维护第二套配色）。写样式时只用语义 token，别写 hex、调色板类名或 `dark:` 变体。

版式与四态走 `src/components/ui/` 的骨架层，别在页面里重造：

| 组件 | 用途 |
|---|---|
| `Page` / `PageHeader` / `SectionHeader` / `Card` | 容器宽度、页头（筛选独立成行）、区块 |
| `TableFrame` / `THead` / `Th` / `Td` / `TableRow` | 表格；`TableRow` 的 `onActivate` 让整行可点且键盘可达 |
| `Pagination` | 分页，总数常显 |
| `Dialog` | 模态（Esc / focus trap / 滚动锁 / aria 齐全）|
| `Select` | 原生 select 封装，`aria-label` 必填 |
| `EmptyState` / `ErrorState` / `TableSkeleton` / `Refreshing` / `StaleDataNotice` | 空 / 错 / 首次加载 / 刷新（保留旧数据不塌陷）/ 刷新失败但旧数据仍在 |
