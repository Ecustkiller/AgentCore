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

> **状态**：✅ 现状 = **BYOK 默认** + 多厂商 provider 路由 + sidecar 推理代理 + **平台凭据作免费档代付上游**（无 key 用户 fallback，`PLATFORM_FREE_TIER_ENABLED`；上游 DeepSeek 官方 flash）。
>
> 本文只记「代码看不出来的」上游接入事实（各厂商接入坑、BYOK key 去向）。计费 / 配额口径见 [`成本配额与计费.md`](/docs/05-平台与运维/成本配额与计费.md)。

---

## 一、总览：三条上游路径

内测默认 **BYOK**。一次 LLM 调用的上游经 `llm/resolve.py` 单点决策，走下面三条之一：

| 路径 | 何时走 | 上游 |
|---|---|---|
| **BYOK 直连**（默认主路） | 用户在「设置 · 模型配置」配了 OpenAI 兼容 key | 用户自带端点（典型 DeepSeek `deepseek-v4-pro/flash`） |
| **多厂商 provider 路由** | model 串带 `厂商/` 前缀 | 豆包 / Moonshot / 智谱 等（见 §四） |
| **platform 平台凭据** | 免费档 fallback（无 key 用户 ∧ `PLATFORM_FREE_TIER_ENABLED`）/ 用户显式偏好 platform / `billing_mode=platform` 全员代付 | `PLATFORM_*` 三项（免费档 = DeepSeek 官方 `deepseek-v4-flash`） |

> **BYOK key 去向**（曾反复踩坑）：每用户自带、**AES-256-GCM 加密存 Postgres**，按 turn 解密注入（`llm/resolve.py::resolve_user_llm_credentials` + `security/keys.py`），**不在 `.env`**。BYOK 模式下 `chat` 回合无用户 key、又无 platform 回退（免费档关闭或平台凭据未配）时返 `402 LLM_KEY_REQUIRED`——新开的 `uv run` / 离线脚本 / `dev` 账号都够不到用户 key，须先给账号设 BYOK key（`PUT /v1/users/me/llm-key` 或桌面「设置 · 模型配置」）。
>
> 计费口径（per-user `billing_preference`、免费档 gate fallback、call 级凭据来源算价）→ [`成本配额与计费.md` §〇·五](/docs/05-平台与运维/成本配额与计费.md)。

---

## 二、模型与凭据解析（服务端权威）

`llm/resolve.py` 是所有调用点的单一解析入口：

- **`resolve_model_config(purpose)`**：按该用户有效计费模式 + `purpose` 决定用 BYOK 还是 platform 凭据。
  - `platform`（用户偏好或全员代付部署）→ 一律 platform（`settings.platform_model`）。
  - `byok`（默认）→ **一切 purpose 都用户 key 优先**（含后台档 `title` / `memory` / `compaction` / `followups`），无 key 才落 platform 凭据（免费档用户的后台调用因此按来源真实入账、吃免费档额度；都无 → `None` → 402）。**2026-07-13 反转**：原「后台档有 platform 时无条件优先 platform 省钱」在无平台 key 的部署下从未生效过（死代码），而免费档一配平台 key 即激活——BYOK 用户后台调用会翻到平台烧钱、且有 key 跳配额 = 白嫖不设限，并破坏「有 key 用户零变化」承诺，故反转为用户 key 优先。
  - **后台模型降档（✅ 2026-07-15）**：后台档的**模型名**解析优先 `background_model`（用户级，`/users/me/llm-key`）→ `platform_background_model`（部署级，默认空=跟随）→ chat 模型（`_model_for_purpose`）。只降模型不换凭据——凭据优先级维持上条 D6 语义。动机：BYOK 用户把 `default_model` 配成贵模型时，标题/记忆等后台调用会跟着烧贵模型。
  - **BYOK 价卡贯穿**：用户自填单价（`price_cache_hit/miss/output`）与 `background_model` 随 `LLMCredentials` 解析、经 log context 贯穿到 `calculate_cost` 全部计价点（云管线 `prepare.py` 与推理代理 `proxy.py` 同路），供 BYOK 估算金额（见 [成本配额与计费 §〇·五](/docs/05-平台与运维/成本配额与计费.md)）。
- **平台模型常量**：`deepseek-v4-flash` / `deepseek-v4-pro`（`llm/profiles.py`）；`settings.platform_model` 默认 `gpt-4o`，仅在 platform 模式作上游模型名。
- **`resolve_turn_model` / `resolve_user_chat_model`**：解析该 turn 的上游 model（BYOK `default_model` → 否则 `platform_model` → 兜底 `deepseek-v4-flash`）。

---

## 三、sidecar 推理代理（桌面本地引擎的 LLM 出口）

桌面「本地 sidecar 引擎」在用户机上跑回合，但**不把 BYOK key 下发到客户端**——经服务端推理代理出网，由服务端解析真实凭据与模型：

- **`POST /v1/inference/token`**：用 cookie 会话换一枚 **scoped inference token**（限流铸发），响应带 `token` + `expires_in_sec` + **服务端解析出的 `model`**（`resolve_user_chat_model`）。
- **`POST /v1/inference/v1/chat/completions`**：sidecar 用 `Authorization: Bearer <inference-token>` 调用。服务端 `inference_user` 解析用户 → `preflight_llm_credentials`（同一道计费闸：BYOK 有 key 直通、无 key 走免费档 fallback + **per-call** `enforce_quota`，耗尽返 429 `FREE_TIER_EXHAUSTED`）→ `build_provider` 转发（unary / SSE）→ 按 call 级凭据来源落账 `cost_calls` / `cost_events`。
- **模型服务端权威**：sidecar 可能仍发 `settings.platform_model`（如 `gpt-4o`），但 BYOK 会覆盖、路由到 DeepSeek——以服务端解析为准（`proxy.py::_llm_request_from_payload`）。

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
4. 抓 SSE：`uv run python scripts/probe_turn.py "<诱导 CEO 发起多模型辩论、正方指定 doubao/doubao-seed-2-1-turbo-260628、反方 deepseek-v4-pro 的消息>"` → 事件存 `logs/probes/probe_<ts>.json` 复盘（CEO 是否照传 model 串有不确定性，消息里明确写出各方模型更稳）。

---

## 五、platform 模式与故障排查

`billing_mode=platform` 时全员走 `PLATFORM_*` 三项（OpenAI 兼容端点）；免费档同三项但默认 DeepSeek 官方 flash。改 `PLATFORM_MODEL` / `PLATFORM_BASE_URL` / `PLATFORM_API_KEY` 须重启后端。

**Sub2API（可选诊断）**：配 `SUB2API_ADMIN_*` 后，platform 模式 503 时可自动探测账号状态（`sub2api_probe.py`），**非当前上游**。

进一步定位：curl 直连 OpenAI 兼容端点（`POST {PLATFORM_BASE_URL}/chat/completions` + Bearer）分辨代理层 vs 上游；查日志关键字 `inference.proxy_upstream_error` / `llm.` 上游错误。
