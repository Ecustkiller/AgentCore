# AgentCore 管理后台 (apps/admin)

平台运营者的**独立 web 控制台**（React + Vite + Tailwind v4）。与桌面端（Electron）解耦，单独部署、独立登录、内网访问。形态决策与后端契约见 [`docs/05-平台与运维/管理员后台.md`](../../docs/05-平台与运维/管理员后台.md)。

## 现状（P0）

- **用户管理**：账号名册（分页 + 搜索）、改角色（user/admin）、禁用 / 启用、改配额。
- 登录：复用后端 `/v1/auth/login`（cookie 会话），仅 `role==admin` 可进；非管理员落「需要管理员权限」墙。
- 用量看板（P1）/ 系统状态（P2）为导航占位，未实现。

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
- 生产：控制台部署在**内网独立 origin**，按需收紧 `COOKIE_SECURE` / `COOKIE_SAMESITE`。

## 类型

REST 类型从后端 OpenAPI 生成（单一真相源），勿手写：

```bash
pnpm gen:api        # openapi-typescript ../server/openapi.json -> src/types/api.generated.ts
```

改了后端 schema 后，先在 `apps/server` 跑 `uv run python scripts/dump_openapi.py`，再回此处 `pnpm gen:api`。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发服务器（5174）|
| `pnpm build` | 类型检查 + 生产构建 |
| `pnpm typecheck` | 仅 `tsc --noEmit` |
| `pnpm gen:api` | 重生成 API 类型 |
