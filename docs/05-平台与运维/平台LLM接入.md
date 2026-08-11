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

> **现状**：目标仍是 `billing_mode=platform`（额度 `quota_*` · ¥10/月·¥10/日 · 台账 **nano-CNY**，无 FX）；**现网可临时 `byok`**（见 [成本配额与计费](/docs/05-平台与运维/成本配额与计费.md) 文首）。**dev 默认仍 BYOK**。本文只记上游接入事实（厂商坑、BYOK 去向、platform 排查）。

## 一、三条上游路径

| 路径 | 何时走 | 上游 |
|---|---|---|
| **BYOK 直连** | 用户配了 OpenAI 兼容服务商 | 用户自带端点（多服务商；典型 DeepSeek） |
| **多厂商 provider 路由** | model 串带 `厂商/` 前缀 | 豆包 / Moonshot / 智谱 等（§四） |
| **platform 平台凭据** | `billing_mode=platform` / 显式 platform | `PLATFORM_*` 三项 |

**BYOK 去向**：每用户多服务商列表（`user_llm_providers`：AES-GCM 密文 key + base_url + `default_model`）；账号/会话选的是**模型组合**（`llm_model_profiles` → `{main, worker?, background?, vision?}` 槽，每槽 `(model, origin, provider_id)`）。服务商上的 `default_model` 仅作连接测试 / 目录种子（UI 在「高级选项 · 连接测试用模型」，Input+datalist 可手填；换厂商预设时保留已填自定义值），**不是**日常聊天默认。测连：优先 `GET /models`（合法 JSON）；空列表或不在列表的 default → `POST /chat/completions` **且验 body**（拒 HTML/非 JSON/缺 choices）；成功文案须标明连通≠聊天就绪，并提示自定义 Base URL 通常需含 `/v1`。key **不在 `.env`**。BYOK 且无服务商、又无 platform 回退 → `402 LLM_KEY_REQUIRED`。

## 二、模型与凭据解析

**模型组合**：CRUD `/v1/users/me/llm-model-profiles`；会话只认 `model_profile_id`（null = 账号默认；**活引用**）。**元数据事实源** = `llm/catalog.py`（上架集）+ `llm/model_metadata.py`（展示 enrichment）；`model_profiles` 只做组合 CRUD / expand，系统预置 = 对 catalog 可见上架集的 uuid5 投影（`uuid5(…, agentcore:platform-preset:{model_id})`，无硬编码产品 UUID）。逻辑默认 = `PLATFORM_MODEL` 对应预置（须在上架集内）否则 allowlist 首个。明确不做：质量档矩阵、账号级角色→模型矩阵、输入框双 picker。✅ **Per-worker 节点显式覆盖**（执行链 + sidecar proxy；确认面不提供人改模）与组合槽正交——定案权威 → [编排器 · Per-worker 模型覆盖](/docs/03-AI核心/编排器与CEO主Agent.md#per-worker-模型覆盖abc-同一功能)。

**识图槽 `vision`（可选）**：与 main **独立**，空 **不** follow main。有槽 → 用该槽凭据建独立 `VisionReader`（BYOK 填槽即可，不因 `billing_mode=byok` 关死）。槽空 → 仅当 `billing_mode=platform` 且 `VISION_API_KEY`/`VISION_BASE_URL` 齐全时走运维兜底（默认 `kimi-k2.5`，不上架 `PLATFORM_MODELS`）。

**对话贴图路由**：回合 **main** 仅当 curated 元数据表（及 family 前缀）标了 `vision` 时走原生 multimodal（`image_url` data URL 挂当前 user，跳过眼睛轨）——**禁止**用目录关键词推断的 `vision` 开原生（防误标 400）。否则 → 上述 `VisionReader` 眼→文注入 system 附件块。同一图禁止双路径。无 reader 且本回合有图 → 诚实提示「未配置识图」，不静默丢像素。白板 `board_read` / 网站 visual critic 仍只用 `VisionReader`（与 main 是否 multimodal 无关）。CEO 可按需调 `read_image` 带着问题再读工作区图。

`llm/resolve.py` 单点：

- **主对话**：用户 key 优先；无 key 才 platform。
- **后台档**（title/memory/compaction）：**平台优先** + 必过 `enforce_quota`（防白嫖）；平台不可用（配置缺失 **或** 上游 auth 拒绝）才回落用户 BYOK。统一入口 `billing/gate.py::run_background_llm`（`resolve_and_gate_background` 解析 + 一次 auth→BYOK；耗尽 / 两边都失败 → `None`，不 429 主回合）。禁止调用点各自 try/except 拼回落、禁止进程内 auth 熔断缓存。原 followups（「下一步」chips）已下线，不再走后台档。
- **回合内鉴权死短路（甲+乙）**：同一用户回合首次确认真 API Key `LLMAuthError`（不含 `INFERENCE_TOKEN_EXPIRED`）后，`llm/turn_auth_dead.py` 回合级死位短路后续未启动的 LLM（主聊后续轮 / 未开跑 worker / 本回合 chrome）；已在飞可自然失败。**不做**跨回合 TTL 负缓存（丙暂缓）。用户文案 / CTA 按 `credential_source` 分流（BYOK→去设置；平台→改用自己的 Key / 联系管理员）。
- **`platform_billing_selectable`**：仅 `billing_mode=platform` 时可选；BYOK 部署不开放平台代付。
- **Worker 槽**：空 = 跟随主模型；跨 origin 时 `build_turn_router` 注入 extras。Sidecar `cost_role=member`：请求 body `model` 为目录路由键（`platform/{id}` / `{provider_id}/{id}`）且合法 → **按该身份重解析凭据/model**；裸 mint/chat id 或未带显式 → 仍跟本槽。非法路由键 **硬失败**（`VALIDATION_ERROR`），禁 silent 回退野模型。→ [编排器 · Per-worker](/docs/03-AI核心/编排器与CEO主Agent.md#per-worker-模型覆盖abc-同一功能)。
- **统一目录** `GET /v1/users/me/models`：键 `(id, origin, provider_id)`；BYOK 行 = `default_model` ∪ 按 `base_url` 匹配的厂商预设 models ∪ 上游 `GET /models` 发现（发现失败/空仍保留预设，避免同厂商下拉只剩一项）；**不是**用前端硬编码清单取代发现。组合槽对 BYOK = **始终可手填 combobox**（服务商 + model id，目录进 datalist 建议；火山 `ep-…`、私有中转等）；platform 仍只 allowlist。platform 行有补贴才列。

## 三、sidecar 推理代理

桌面本地引擎**不拿 BYOK key**——经服务端出网：`POST /v1/inference/token` 铸 scoped token + 服务端解析 `model`；`POST /v1/inference/v1/chat/completions` 过同一道计费闸后转发。模型以服务端解析为准。→ `api/routes/inference/`；整体 → [双模式工作区](/docs/02-架构/双模式工作区.md)。

**铸票 `token.model`**：可选 body `{ conversation_id? }`。有合法且属该用户的会话 → 与代理主槽同源 expand（`resolve_conversation_model_selection(...).model`，会话钉组合优先）；缺省 / 会话不存在或不属于该用户 → 账号默认（`resolve_user_chat_model`）。JWT **只绑 user**，不把 `conversation_id` 塞进 claims；返回的 model id 诚实透传（禁 silent 把 `flash-free` 糊成 `flash`）。

**令牌 TTL**：默认 `inference_token_expire_minutes=720`（12h）。桌面在每次 `startTurn` / `resume` **强制续铸**；开跑前若代理仍拒票则清缓存换票再 RPC 一次。代理 401/403 映射为 `INFERENCE_TOKEN_EXPIRED`（可重试、勿引导「去设置 · 服务商」），与 BYOK 的 `LLM_KEY_INVALID` 区分。

## 四、多厂商 provider 路由

`provider/model` 前缀 → `ProviderRouter`（空 key = 不注册）。辩论多凭据 → [辩论编排 §7.5](/docs/03-AI核心/辩论编排设计.md)。

- 带前缀 → 厂商；无前缀 → 默认 DeepSeek BYOK；未注册前缀 → 回退默认、模型名透传。
- **火山方舟**：一把 `ark-…` key + `https://ark.cn-beijing.volces.com/api/v3`；model 必须传**接入点 ID（`ep-…`）或已开通模型 ID**。BYOK 预设种子为 `doubao-seed-2-1-turbo-260628`，旧 `doubao-pro-32k` / `doubao-lite-32k` 裸名不可用。
- **兼容性铁律**：只发标准 OpenAI 字段，不发 DeepSeek 特有 `thinking` 等（别家网关会 400）。

## 四·附、DeepSeek API 易错约束（BYOK 常用）

官方文档：https://api-docs.deepseek.com。产品路由 / 计费仍以上文为准。以下为**外部 API 约束**（代码里看不出来）：

| 项 | 约束 |
|---|---|
| 模型名 | `deepseek-v4-pro` / `deepseek-v4-flash`；旧名 `deepseek-chat` / `deepseek-reasoner` 已停用 |
| base_url | `https://api.deepseek.com`（兼容 `/v1`） |
| 思考开关 | `extra_body.thinking.type=enabled/disabled`，默认 enabled；AgentCore 只用此开关 |
| 温度坑 | **思考模式下** `temperature`/`top_p`/penalty **静默忽略** |
| 工具调用 | 有 tool call 的回合必须原样回传 `reasoning_content`，否则 400 |
| 其它 | 不支持强制 `tool_choice=required`（probe 遇 400 回退）；无 `developer` role |

**思考开关按角色**：CEO / worker / 单聊 = on；后台 one-shot（title/memory/compaction/file.rewrite）= disabled。无 per-agent 思考强度档。

## 四·附、Moonshot / Kimi 易错约束（BYOK 常用）

官方：[Model Parameter Reference](https://platform.kimi.ai/docs/api/models-overview)。与 DeepSeek「思考模式下 temperature **静默忽略**」不同——Kimi 当前代对采样参数是**硬拒**（传错值 → 400）。

| 项 | 约束 |
|---|---|
| 模型名 | 预设种子 `kimi-k2.6` / `kimi-k3` / `kimi-k2.5`；legacy `moonshot-v1-*` 仍可自由采样 |
| base_url | `https://api.moonshot.cn/v1`（别名 `.ai`） |
| 温度坑 | `kimi-*`：**勿显式传** `temperature`（k3 / k2.7-code 固定 1.0；k2.5/k2.6 = thinking 1.0 / non-thinking 0.6）。传 0.7 等 → `invalid temperature: only 1 is allowed` |
| 出站 | `wire_dialect.omit_temperature`：`kimi-` 叶 + Moonshot 预设 base_url（非 `moonshot-v1*`）省略；OpenCode Zen 等多模型端点**不**整端 omit，靠叶规则 |
| 未做 | 不为 Kimi 单开 `thinking.type` / `reasoning_effort` 产品档；不做 400 自适应重试补 temperature |

## 四·附、腾讯 Hy / TokenHub（BYOK 预设）

BYOK 厂商预设 id=`hy`；canonical `https://tokenhub.tencentmaas.com/v1`（广州）；备用 `.cn` 与国际站仅作 base_url 匹配别名。模型目录种子：`hy3`（默认）、`hy3-preview`。

| 项 | 约束 |
|---|---|
| 模型名 | `hy3` / `hy3-preview`（wire 精确匹配；其它 TokenHub `hy-*` 不走思考方言） |
| 思考开关 | 与 DeepSeek 同形：`thinking.type=enabled/disabled`；角色策略同上附 |
| 工具调用 | 有 tool call 的回合必须回传 `reasoning_content` |
| 未做 | 不暴露 `reasoning_effort` UI；不做 `hy/` 平台前缀路由 |

## 四·附、OpenCode Zen（BYOK 预设 + 可作 platform 上游）

BYOK 厂商预设 id=`opencode_zen`；canonical `https://opencode.ai/zen/v1`。品牌对外暴露为「OpenCode Zen」。预设 `models` 仅短种子（发现失败兜底）；全量目录靠上游 `GET /models` 与现有 BYOK 发现合并。

| 项 | 约束 |
|---|---|
| 协议 | 主路仍 OpenAI `chat/completions`（Flash / GLM 等兼容行）；目录有 ≠ 一定能跑（Claude / GPT 等可能需其它协议） |
| BYOK | 用户自备 Zen key；估算价卡按现有 BYOK 两层解析；**不**进平台配额 |
| 平台代付 | ✅ 可经 `PLATFORM_*` 指向同一 Zen 端点；**现网定案**：只上架 `deepseek-v4-flash-free`（见 §五·附） |
| 未做 | `zen/` 前缀路由；为本网关单独开 Anthropic/Responses 分叉 |
| 隐私 | free 档限时且可能用于改进模型——产品公告须诚实；勿当永久免费算力承诺 |

## 五、platform 模式与故障排查

`billing_mode=platform` 走 `PLATFORM_*`；改三项须重启后端。

**多模型 + 每模型凭据覆盖**（成本 §〇·六 F3）：`PLATFORM_MODELS` allowlist（非空时 `PLATFORM_MODEL` / 后台档须 ∈ 列表，否则启动 fail-fast）；`PLATFORM_MODEL_CREDENTIALS`（JSON `{model → {api_key?, base_url?, upstream_model?}}`）给「一 key 一模型」中转绑独立凭据；可选 `upstream_model` 让目录 id 与上游 id 解耦（如 `glm-5.2-jiu` → 上游仍发 `glm-5.2`；计费 / 目录仍用目录 id）。单点 `platform_llm_credentials(model=…)` + 出站改写 `platform_wire_model`（`PlatformProvider`）。可用性 = 默认 key **或**任一覆盖有 key。缺 curated 价卡的 allowlist id → 不上架。

**排查**：curl 直连 `{PLATFORM_BASE_URL}/chat/completions` 分辨代理 vs 上游；日志 `inference.proxy_upstream_error` / `llm.*`。可选 `SUB2API_ADMIN_*` 探测（非当前上游）。

**本机系统代理**：产品出网 httpx 默认 `trust_env=False`（不继承 `HTTP(S)_PROXY` / `ALL_PROXY`）。用户装 Clash 等把 `ALL_PROXY` 设成 `socks5://…` 时，旧行为会因缺少可选依赖 `socksio` 报「调用失败」；桌面 sidecar 启动时另剥离 SOCKS 类代理环境变量（HTTP 代理保留）。显式应用内代理配置仍可后续加，不靠默吃系统 SOCKS。

## 五·附、现网单模型：OpenCode Zen · DeepSeek V4 Flash Free

> 运维定案（内测恢复平台额度）：平台目录只上架 **一个**模型；BYOK 仍为高级选项（F7）。先本地 `BILLING_MODE=platform` 冒烟，再改生产。
>
> **模型修订**：本地账号实际可用的是 Zen 限时免费档 `deepseek-v4-flash-free`（付费 `deepseek-v4-flash` 同 key 会 `CreditsError`）。平台现网钉 **free**；诚实告知限时 / 可能用于改进模型（见 Zen 隐私条款）。

| 项 | 值 |
|---|---|
| `BILLING_MODE` | `platform` |
| `PLATFORM_BASE_URL` | `https://opencode.ai/zen/v1` |
| `PLATFORM_MODEL` / `PLATFORM_MODELS` | `deepseek-v4-flash-free`（仅此） |
| 后台档 | 同钉 `deepseek-v4-flash-free`（可显式 `PLATFORM_BACKGROUND_MODEL`，须 ∈ allowlist） |
| 额度 | 月 ¥10 · 日 ¥10 · 日请求 500（`quota_*` 不变） |
| 价卡 | curated 名义价 **同** 付费 Flash（¥0.02 / ¥1 / ¥2）——上游免费，产品仍按名义价扣额度 |
| Vision | 本阶段不配 `VISION_*`（白板读图仅用户 BYOK 填 vision 槽时可用） |
| 公告 | 恢复时归档 `quota_jiurelay`；发模板 **`quota_platform_restored`** → [产品公告文案模板 §4.2](/docs/05-平台与运维/产品公告文案模板.md) |

验收信号：无 Key 账号可开聊并扣额度；`GET /v1/users/me/models` 平台行仅 `deepseek-v4-flash-free`；输入区徽章 / `run_completed.model` / `cost_events.model` 同为该 id。
