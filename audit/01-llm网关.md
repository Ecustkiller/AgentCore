# 01 · LLM 网关审计分册

> 范围：`apps/server/agentcore/llm/`（provider / factory / profiles / resolve / errors / pricing / credentials / key_service / observability / sub2api_probe / tools_gate）+ `api/routes/inference/`（token.py / proxy.py）+ `conversation/`（quota.py / rate_limit.py / inference_rate_limit.py）。
>
> 只读审计，未改任何源码。每条发现均已读到接缝两端代码确认（防误报铁律）；仅需线上复跑确认的另标 `NEEDS-VERIFY`。

## 严重度汇总

| 严重度 | 数量 | 编号 |
|---|---|---|
| P0 | 1 | F1 |
| P1 | 0 | — |
| P2 | 5 | F2 F3 F4 F5 F6 |
| P3 | 6 | F7 F8 F9 F10 F11 F12 |
| 合计 | 12 | |

类别分布：SEAM×4、DRIFT×3、BUG×1、DESIGN×2、TEST×1、SEC(并列)×1。

---

## P0

### F1 · SEAM/BUG · 推理代理丢弃 `tool_calls` / `tool_call_id` / `reasoning_content`，sidecar 多轮工具调用必然 400

- **证据（消费端，丢字段）**：`api/routes/inference/proxy.py:133-147` —
  `_llm_request_from_payload` 只取 `role` + `content` 重建消息：
  `LLMMessage(role=m["role"], content=m.get("content"))`（proxy.py:135）。`tool_calls`、`tool_call_id`、`reasoning_content` 全部被丢弃，然后又交给下游 `build_provider(creds)` 重新 `_build_payload` 发往真上游。
- **证据（生产端，确实发了这些字段）**：sidecar 本地引擎经 `OpenAICompatibleProvider` 打到代理，`llm/provider/openai_compatible.py:236-259` 的 `_build_payload` 会序列化 `tool_calls`、`tool_call_id`、`reasoning_content`（并对 assistant 工具轮自动补 `reasoning_content=""`）。工具结果消息由引擎 `runtime/engine/tool_exec.py:178`（`LLMMessage(role="tool", content=output, tool_call_id=tc.id)`）产出，随历史进入下一轮请求体。desktop `services/inferenceToken.ts` 把 `baseUrl` 指向 `/v1/inference/v1`、由 `OpenAICompatibleProvider` 拼 `/chat/completions`，确认 sidecar 走的正是此代理。
- **证据（上游契约，缺字段=400）**：`docs/03-AI核心/DeepSeek-V4-API参考.md` §4.3（134-135 行）「有 tool call 的多轮对话：`reasoning_content` 必须完整传回，否则 400 报错」；§6.4（205-213 行）role=tool 必带 `tool_call_id`；§7.1（219 行）同。OpenAI/DeepSeek 规范均要求 role=tool 关联 `tool_call_id` 且前置 assistant 带 `tool_calls`。
- **影响**：第 1 轮（user+tools）能拿到 tool_calls，但一旦执行工具、回传结果发起第 2 轮，代理把 assistant.tool_calls / tool.tool_call_id / reasoning_content 全部剥掉 → 上游收到孤立的 tool 消息与缺 reasoning_content 的思考轮 → **400**。即经云推理代理的 sidecar/本地回合，**任何多轮工具调用（委派 delegate、辩论 debate、web_search 等核心多 Agent 能力）全线不通**。云端 SSE 回合直连上游、不过此代理，不受影响。
- **修复方向**：`_llm_request_from_payload` 应完整还原消息（tool_calls / tool_call_id / reasoning_content 原样透传），或让代理对 `/chat/completions` 做「服务端只覆盖 model + 鉴权 + 落账、其余请求体透传」的透明转发，避免在网关重建时丢结构化字段。
- **复跑确认（非对代码的存疑，仅建议线上验证）**：sidecar 发一条会触发工具/委派的消息，抓第 2 轮代理→上游请求体是否缺 `tool_call_id` 并观察 400。

---

## P2

### F2 · TEST · 推理代理转发测试只覆盖纯文本，无工具轮/思考轮回环（掩盖了 F1）

- **证据**：`apps/server/tests/test_inference_proxy.py` 全部转发用例的消息体均为 `{"role":"user","content":"hi"}`（如 312-317、320-336、347-368、399-409 行），无一条构造 assistant `tool_calls` + role=tool `tool_call_id` + `reasoning_content` 过代理的断言。`_llm_request_from_payload` 的唯一测试（320-336）只验证 model 覆盖。
- **影响**：核心 sidecar 路径（多轮工具调用）端到端零覆盖，正是 F1（P0）长期不被发现的原因。
- **修复方向**：补一条「工具轮回环过代理」用例——断言代理转发后的上游请求体仍含 `tool_calls` / `tool_call_id` / `reasoning_content`（可用 `httpx.MockTransport` 捕获出站 body 断言）。

### F3 · DRIFT/BUG · 定价表仅含 DeepSeek 系，`platform_model` 默认 `gpt-4o`（codex 档 `gpt-5.5`）不在表内 → platform 模式全量按 Flash 兜底计价

- **证据**：`llm/pricing.py:48-83` 的 `_PRICING` 只有 `deepseek-v4-flash/pro`、`doubao/...`、`qwen-vl-max`；`_DEFAULT_MODEL = DEEPSEEK_V4_FLASH`（pricing.py:87），未知 model 回落 Flash（pricing.py:133、166-173 打 `cost.pricing_fallback`）。而 `config/platform.py:9` `platform_model` 默认 `"gpt-4o"`，`平台LLM接入.md:97-98` 的 codex 档 `PLATFORM_MODEL=gpt-5.5`——两者都不在定价表。
- **影响**：platform 计费模式下（`billing_mode=platform`）真实上游是 gpt-4o/gpt-5.5，却一律按 Flash 档折价 → `cost_events` 台账系统性低估、连带**月成本配额**（`quota_monthly_cost_usd`）判定失真。当前 `billing_mode` 默认 `byok`（byok 跳过定价、成本记 0），故为休眠期潜伏风险；一旦翻 platform 立即命中。
- **修复方向**：定价表补齐 platform 实际上游模型（或按厂商前缀匹配版本号，见 pricing.py:34-35 的 Phase 2 TODO）；或在 platform 模式启动时校验 `platform_model ∈ _PRICING`，否则显式告警/拒启，避免静默低估。

### F4 · SEAM · 「日请求数」配额被 sidecar 代理回合绕过（`message_id=NULL` 不计入 `COUNT(DISTINCT message_id)`）

- **证据**：代理落账走 `proxy.py:88-110` → `runtime/costing.py:142-170` 的 `background_run_cost`，写入 `record_runs(..., message_id=None, ...)`（proxy.py:105-110、billing.py:50-53）。配额里「日请求数」用 `quota.py:136-145` 的 `today["turns"]`，而 `db/repositories/billing.py:117` 的 `turns = COUNT(DISTINCT CostEvent.message_id)` —— Postgres 的 `COUNT(DISTINCT)` 忽略 NULL。
- **影响**：sidecar/本地回合的账目 `message_id` 恒为 NULL，故**永不计入日请求数维度**；`quota_daily_requests`（默认 200/日）对 sidecar 用户失效。日 token 与月成本维度仍生效（二者 SUM 全部行，含 NULL），故为部分绕过。
- **修复方向**：要么让代理回合以真实 `message_id` 落账（需拿到本地回合的 assistant message_id），要么日请求维度改用「非 NULL message_id 计数 + 代理回合另计数」的口径，使三维度对 sidecar 一致生效。

### F5 · DESIGN/SEC · 推理代理热路径无「按用户消息限流」，最外层速率防线对 sidecar 缺位

- **证据**：`enforce_user_message_rate_limit` 只挂在云回合路由（`api/routes/conversations/turns.py:105`、`messages.py:272`、`handoff.py:150`），`/inference/v1/chat/completions`（`proxy.py:150-188`）**未调用**任何按用户限流。推理路径唯一限流是铸发端 `token.py:37` 的 `enforce_inference_token_mint_rate_limit`（`config/auth.py:17` 默认 10 次/60s），但令牌 TTL 2h（`config/auth.py:15`）内可无限次调用 `/chat/completions`。
- **影响**：sidecar 回合绕过「速率」防线（成本配额与计费.md §一 声明速率防线覆盖「消息发送/重新生成端点」）；持一枚令牌可高频刷代理 → 突发压垮平台 key / 上游或（BYOK 下）无任何速率/配额约束。部分缓解：铸发限流 + platform 模式的总量配额。
- **修复方向**：在代理入口按用户加轻量速率闸（口径需避免误伤同一回合内多轮 LLM 调用，例如按「回合起」而非「每轮」计），或收紧令牌 TTL / 单令牌调用配额，使速率防线两条路径对称。

### F6 · DRIFT/SEAM · 每 Agent `reasoning_effort`（含 `max` 解锁）声明了但从不发往上游，纯 UI 信号

- **证据（声明+透出）**：`runtime/runs/types.py:177` RunSpec 有 `reasoning_effort`；`runtime/runs/builder.py:356-377` 解析；`tools/builtin/delegate/schema.py:84` 暴露给 CEO；`runtime/skills.py:91`「极复杂子任务可再设 `reasoning_effort="max"` 解锁更深推理」；`delegate/drive.py:181` 跨委派复制；debate/plan events 投影到前端。
- **证据（从不落到请求体）**：`llm/provider/protocol.py:39-47` `LLMRequest` **无** `reasoning_effort`/`thinking` 字段；`openai_compatible.py:236-274` `_build_payload` 只发 model/messages/stream/temperature/max_tokens/tools/tool_choice/stream_options。全仓 `reasoning_effort` 消费点仅止于「解析/存储/复制/投影」，无一处写进 payload 或 extra_body。这与 `平台LLM接入.md:72`「兼容性铁律：只发标准字段，不发 DeepSeek 特有 `thinking`/`reasoning_effort`」正相冲突。
- **影响**：CEO 与运营看到「可解锁 max 更深推理」的旋钮，实则**对真实调用零影响**（DeepSeek 默认 thinking on/high，`max` 永不下发）；档位在 UI/审计上产生误导信号（声明了没接通）。`thinking` 那一半因 DeepSeek 默认开启而无害。
- **修复方向**：二选一并写清——① 若要支持 max：让 `LLMRequest` 承载并在（可探测支持的）DeepSeek 端经 `extra_body` 下发，其余厂商降级；② 若坚持「只发标准字段」：移除/下线 `reasoning_effort=max` 这一 CEO 面旋钮与 skills 文案，避免声明未接通。（属跨分册接缝，引擎档位消费侧详情待 02/03 分册；本册确认丢弃点在 provider。）

---

## P3

### F7 · DRIFT · 推理令牌 TTL：代码默认 2h，文档/注释称 12h

- **证据**：`config/auth.py:15` `inference_token_expire_minutes: int = 120  # 2h`；但 `docs/02-架构/双模式工作区.md:152`「token 12h TTL」、`sidecar/server_pkg/handlers.py:114` 注释「12h TTL」。
- **影响**：文档/注释与代码不符，误导对令牌刷新频率的判断（功能上 desktop 每回合重发 inference 块，实际无碍）。
- **修复方向**：统一为一个值；若确定 2h，改文档与注释。

### F8 · SEAM(minor) · 代理流式转发丢弃 provider 的空响应诊断 `empty_diagnosis`

- **证据**：`openai_compatible.py:231-234` 空响应时 yield 末尾 `LLMChunk(empty_diagnosis=..., empty_raw_preview=...)`；`proxy.py:258-276` 的 `_iter_sse` 只看 delta_content/reasoning/finish/usage，对 `empty_diagnosis` 不做任何转发（产出一个空 delta）。
- **影响**：代理侧算出的精确诊断（OAUTH_EXPIRED / MODEL_UNKNOWN 等）丢失，sidecar 只能凭空 delta 自行退化为泛化 SILENT_EMPTY，用户失去「刷新 OAuth」等可操作提示。
- **修复方向**：把 `empty_diagnosis`/`empty_raw_preview` 透传为一个可被 sidecar 识别的 SSE 字段（或错误事件），保留诊断保真度。

### F9 · BUG(edge) · `Retry-After` 只按秒解析，HTTP-date 值会抛 ValueError 逃出错误映射

- **证据**：`openai_compatible.py:310` `retry_after = float(headers.get("retry-after", backoff))`。RFC 允许 `Retry-After` 为 HTTP-date，`float()` 对其抛 `ValueError`，不属 LLMError/httpx 异常，逃出 `_request_with_retry` 的 except → 最终被路由 `except Exception` 兜成泛化 502。
- **影响**：上游以日期形式返回 429 时，限流被误报为「上游不可达」。DeepSeek 返回整数秒，故实际概率低。
- **修复方向**：`Retry-After` 解析兼容整数秒与 HTTP-date，解析失败回落 `backoff`。

### F10 · DESIGN(minor) · 两个凭据解析入口对「byok+无 key+有 platform」语义相左

- **证据**：`llm/resolve.py:116-135` `resolve_model_config`（chat 目的、byok、无用户 key、平台可用）**回退 platform** 并返回模型；而 `billing/gate.py:44-49` `preflight_llm_credentials`（byok、无 key）**抛 402 `BYOKKeyMissingError`**、不回退。两处均各有文档背书（平台LLM接入 §二 vs 成本配额与计费 §〇·五），但对同一情形结论矛盾。
- **影响**：当前无害——用户向回合先过 preflight（402 收口），`resolve_model_config`/`resolve_user_chat_model` 仅用于「令牌 advisory model / turn profiles 选型」（`common.py:135` 只取 model 名，不建 provider、不授权）。属潜伏陷阱：若将来有调用点绕过 gate 直接用 resolve_* 建 provider，keyless byok 用户可能静默跑在平台 key 上。
- **修复方向**：统一 byok 无 key 语义（建议二者都走 402），或明确 `resolve_model_config` 仅供「选型/展示」、绝不用于授权，并在文档消歧。

### F11 · SEAM(minor) · 代理非流式响应丢弃 `reasoning_content`

- **证据**：`proxy.py:223-225` unary 分支 `message = {"role":"assistant","content":...}`（+ tool_calls），不含 `reasoning_content`（流式分支 264-265 有转发）。
- **影响**：若 sidecar 走非流式思考模式，assistant 的 reasoning_content 丢失；叠加 F1 的请求侧丢弃，进一步恶化思考轮回传。sidecar 默认流式，故影响有限。
- **修复方向**：unary 响应一并回传 `reasoning_content`。

### F12 · SEC(minor)/NEEDS-VERIFY · 落账按客户端可控的 `X-AgentCore-Conversation` 头归属，未校验会话归属

- **证据**：`proxy.py:159` 从头取 `conversation_id`，`proxy.py:88-110` 直接以该值 + `user.user_id` 落 `cost_events`，无「会话属于该用户」校验。
- **影响**：读侧聚合均按 `(conversation_id, user_id)` 双收敛（billing.py:138-143 等），故无跨用户泄漏或污染他人总额；至多把自己的花销误挂到自己无权的 conversation_id 上（本人账本视图内）。低影响。
- **NEEDS-VERIFY**：`cost_events.conversation_id` 若有指向 `conversations` 的 FK，则未知 id 写入会失败（被 `except` 吞掉）；建议确认 FK 与是否需要在代理侧校验会话归属。

---

## 附：已核查为「非问题」（避免复审重复劳动）

- **错误映射完整性**：`openai_compatible.py:300-343` + `errors.py` 对 429/401/403/402/5xx/4xx/超时映射齐全且分类正确；401/402/403 标 `retryable=False` 不重试、5xx `retryable=True`（`core/errors.py:33-99`）；`except LLMUpstreamError` 先于 `except (LLMRateLimitError, LLMError)`，顺序正确，无吞异常。
- **定价缓存拆分对账**：`pricing.py:174` `cache_miss = max(input − cache_hit, cache_miss)`，缺拆分字段时整段按 miss 计，不会静默记 0；钱全程整数 nano-USD、Decimal 计算，无浮点。
- **令牌隔离**：`security/tokens.py` inference 令牌 `type="inference"`，与 access 互拒（decode 双向校验），平台 key 不下放客户端；`inference_user` 校验 `status=="active"`。
- **ProviderRouter 前缀路由**：`provider/router.py` 前缀命中/回退默认逻辑正确，未注册前缀原样透传，与文档一致。
- **BYOK 写面 fail-safe**：`key_service.py` 无主密钥拒存明文、掩码只留后 4 位、probe 复用运行时同一解析路径。
