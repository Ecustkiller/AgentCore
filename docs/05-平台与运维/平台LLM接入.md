---
status: reference
code: apps/server/agentcore/llm/
related:
  - docs/05-平台与运维/成本配额与计费.md
  - docs/03-AI核心/辩论编排设计.md
skip_if:
  - 不涉及 LLM 上游 / 模型解析 / BYOK
---

# 平台 LLM 接入

> **状态**：✅ 现状 = **BYOK 默认** + 多厂商 provider 路由 + sidecar 推理代理；`platform` / codex 为**可选休眠上游**（`config/platform.py` 的 `billing_mode` 默认 `"byok"`）。
>
> 本文只记「代码看不出来的」上游接入事实（各厂商接入坑、BYOK key 去向、codex 遗留 runbook）。计费 / 配额口径见 [`成本配额与计费.md`](/docs/05-平台与运维/成本配额与计费.md)。

---

## 一、总览：三条上游路径

内测默认 **BYOK**。一次 LLM 调用的上游经 `llm/resolve.py` 单点决策，走下面三条之一：

| 路径 | 何时走 | 上游 |
|---|---|---|
| **BYOK 直连**（默认主路） | 用户在「设置 · 模型配置」配了 OpenAI 兼容 key | 用户自带端点（典型 DeepSeek `deepseek-v4-pro/flash`） |
| **多厂商 provider 路由** | model 串带 `厂商/` 前缀 | 豆包 / Moonshot / 智谱 等（见 §四） |
| **platform / codex（休眠）** | `billing_mode=platform` 且配了 `PLATFORM_API_KEY` | 外部 `codex_chat_proxy` → ChatGPT Codex（见 §五，默认关） |

> **BYOK key 去向**（曾反复踩坑）：每用户自带、**AES-256-GCM 加密存 Postgres**，按 turn 解密注入（`llm/resolve.py::resolve_user_llm_credentials` + `security/keys.py`），**不在 `.env`**。BYOK 模式下 `chat` 回合无用户 key、又无 platform 回退时返 `402 LLM_KEY_REQUIRED`——新开的 `uv run` / 离线脚本 / `dev` 账号都够不到用户 key，须先给账号设 BYOK key（`PUT /v1/users/me/llm-key` 或桌面「设置 · 模型配置」）。

---

## 二、模型与凭据解析（服务端权威）

`llm/resolve.py` 是所有调用点的单一解析入口：

- **`resolve_model_config(purpose)`**：按 `billing_mode` + `purpose` 决定用 BYOK 还是 platform 凭据。
  - `billing_mode=platform` → 一律 platform（`settings.platform_model`）。
  - `billing_mode=byok`（默认）→ 后台档 purpose（`title` / `memory` / `compaction` / `followups`）在有 platform 时优先走 platform 省钱；`chat` 等用户向回合走用户 BYOK key，无 key 再回退 platform（都无 → `None` → 402）。
- **平台模型常量**：`deepseek-v4-flash` / `deepseek-v4-pro`（`llm/profiles.py`）；`settings.platform_model` 默认 `gpt-4o`，仅在 platform 模式作上游模型名。
- **`resolve_turn_model` / `resolve_user_chat_model`**：解析该 turn 的上游 model（BYOK `default_model` → 否则 `platform_model` → 兜底 `deepseek-v4-flash`）。

---

## 三、sidecar 推理代理（桌面本地引擎的 LLM 出口）

桌面「本地 sidecar 引擎」在用户机上跑回合，但**不把 BYOK key 下发到客户端**——经服务端推理代理出网，由服务端解析真实凭据与模型：

- **`POST /v1/inference/token`**：用 cookie 会话换一枚 **scoped inference token**（限流铸发），响应带 `token` + `expires_in_sec` + **服务端解析出的 `model`**（`resolve_user_chat_model`）。
- **`POST /v1/inference/v1/chat/completions`**：sidecar 用 `Authorization: Bearer <inference-token>` 调用。服务端 `inference_user` 解析用户 → `preflight_llm_credentials`（配额 + BYOK 检查）→ 有 BYOK 用 BYOK、否则用 platform → `build_provider` 转发（unary / SSE）→ 落账 `cost_events`。
- **模型服务端权威**：sidecar 可能仍发 `settings.platform_model`（如 `gpt-5.5`），但 BYOK 会覆盖、路由到 DeepSeek——以服务端解析为准（`proxy.py::_llm_request_from_payload`）。

→ 见代码：`api/routes/inference/`（`token.py` 铸发 + `proxy.py` 转发）。sidecar 整体见 [`双模式工作区.md`](/docs/02-架构/双模式工作区.md)。

---

## 四、多厂商 provider 路由（真·多模型辩论 / BYOK）

按 **`provider/model` 前缀路由到不同厂商**（`llm/provider/router.py::ProviderRouter` + `llm/provider/openai_compatible.py::OpenAICompatibleProvider`，`llm/factory.py::build_router` 据已配厂商 key 组装；空 key = 不注册、回退默认，普通对话零行为变化）。这是「真·多模型辩手」（辩论各方各自指定模型）的执行支点，见 [`辩论编排设计.md §7.5`](/docs/03-AI核心/辩论编排设计.md)。

**model 串格式（路由约定）**：

- 带前缀 → 路由到厂商：`doubao/doubao-seed-2-1-turbo-260628`。
- 无前缀 → 默认 provider（DeepSeek BYOK）：`deepseek-v4-pro` / `deepseek-v4-flash`。
- 未注册前缀 → 回退默认 provider，模型名原样透传。

**火山方舟（豆包）接入事实**：

- 一把 key（`ark-...`）+ 同一 OpenAI 兼容端点即可托管多模型（豆包 / DeepSeek-V4 / 智谱 GLM / 通义千问）；`base_url` 默认 `https://ark.cn-beijing.volces.com/api/v3`，key 走 `DOUBAO_API_KEY`（`.env`，不入库）。
- **model 字段必须传【接入点 ID（`ep-…`）或已开通的模型 ID】**——单有 key 点不到模型（与 DeepSeek / Kimi 不同）。
- 已开通 `doubao-seed-2-1-turbo-260628`（**深度思考模型**，答一句烧 ~500 reasoning token → 多轮多辩手偏贵偏慢，心里有数）。Kimi 不在方舟（需单独 Moonshot key）。
- **兼容性铁律**：`OpenAICompatibleProvider` **只发标准字段**（model / messages / stream / temperature / max_tokens / tools），不发 DeepSeek 特有 `thinking` / `reasoning_effort`（别家网关会 400）；usage 用标准 OpenAI 键、cache 拆分缺失记 0。

**真跑一场多模型辩论（dev 验证配方）**——走正规 `/auth/token` + `/messages`、无旁路：

1. 后端 + 桌面 dev 在跑（`:8000` `readyz` 200）。
2. seed dev 账号：`uv run python scripts/seed_dev_user.py`（`dev` / `devpassword`）。
3. **dev 账号需先有 BYOK DeepSeek key**（见 §一），否则发回合即 `402 LLM_KEY_REQUIRED`。
4. 抓 SSE：`uv run python scripts/probe_turn.py "<诱导 CEO 发起多模型辩论、正方指定 doubao/doubao-seed-2-1-turbo-260628、反方 deepseek-v4-pro 的消息>"` → 事件存 `logs/probe_<ts>.json` 复盘（CEO 是否照传 model 串有不确定性，消息里明确写出各方模型更稳）。

---

## 五、platform / codex 休眠上游（opt-in 遗留）

> **仅当 `billing_mode=platform`** 时启用；内测默认关。以下为该模式的 runbook，保留备用。

**架构**：`billing_mode=platform` 时经外部 `scripts/codex_chat_proxy.py`（localhost:9090）把标准 OpenAI chat/completions 翻译为 Codex Responses API、连 ChatGPT Codex 后端（`https://chatgpt.com/backend-api/codex/responses`）。

**可用模型（仅 codex 模式）**：K-12 Codex 账号仅 `gpt-5.4` / `gpt-5.5`（通用模型名 `gpt-4o` 等会被 Codex 后端拒）。**注意**：这只约束 codex 上游，与 BYOK / 多厂商各自的模型无关。

**配置（`.env`）**：

```env
BILLING_MODE=platform            # 默认 byok；仅切平台模式才设 platform
PLATFORM_API_KEY=sk-xxx          # 任意非空（代理不校验）
PLATFORM_BASE_URL=http://localhost:9090/v1
PLATFORM_MODEL=gpt-5.5
```

凭证 `config/codex-credentials.json`：代理启动时读 `access_token`（JWT，约 10 天过期）向 ChatGPT 后端认证；过期用 CPA 工具重取并重启代理。

**启动**：`python scripts/codex_chat_proxy.py --port 9090` 后再起 AgentCore。

**Sub2API（遗留诊断探针）**：早期用 Sub2API 网关，因账号 K-12（`chatgpt_plan_type: k12`）被拒 chat/completions，改直连 codex。现 Sub2API 仅作 platform 模式 503 时的账号状态诊断（`sub2api_probe.py`，配 `SUB2API_ADMIN_*`），**非当前上游**。

**故障排查**：

| 症状 | 原因 | 解决 |
|------|------|------|
| 代理返回 502 upstream_error | Token 过期或上游故障 | 刷新 token |
| 400 "model not supported when using Codex" | 用了非 Codex 模型名 | 改用 `gpt-5.4` / `gpt-5.5` |
| AgentCore 503「平台服务端错误」 | 代理未启动 | 启动 `codex_chat_proxy.py` |
| 连接被拒 | 代理未启动或端口不对 | 检查 9090 端口 |

---

## 六、未来演进

- codex token 自动刷新（当前手动）、多账号轮转 / 负载均衡。
- 获非 K-12 账号后可直连 OpenAI API、去掉代理层。
