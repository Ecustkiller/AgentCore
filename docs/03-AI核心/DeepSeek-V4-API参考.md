---
status: reference
code: ""
related:
  - docs/05-平台与运维/平台LLM接入.md
  - docs/03-AI核心/执行引擎架构设计.md
skip_if:
  - 只改 AgentCore 内部行为（读 平台LLM接入 / 03-AI）
---

# DeepSeek V4 API 开发参考

## AI 速查（易错约束）

> 本段保留 **AI 易错的约束子集 + 按角色分档（权威）**。上游规格速览与补充易错点见下文，完整参考链官方文档；技术架构 §二 以本段为思考强度档位的权威来源。

### DeepSeek V4 配置事实（权威，AI 易错点）

DeepSeek V4 是 BYOK 常用目标之一（平台免费档亦直连 DeepSeek 官方，见 [平台LLM接入.md](../05-平台与运维/平台LLM接入.md)）。以下是 DeepSeek 的**外部 API 约束**（代码里看不出来），用 DeepSeek 时以此为准：

| 项 | 正确值 / 约束 |
|---|---|
| 模型名 | `deepseek-v4-pro`（旗舰）/ `deepseek-v4-flash`（默认档）。旧名 `deepseek-chat`/`deepseek-reasoner` 已退役——**勿再写旧名** |
| base_url | `https://api.deepseek.com`（兼容 `/v1`）；升级只换 model 名，base_url 不变 |
| 双模式 | 思考 / 非思考。思考开关在 `extra_body` 里传 `thinking.type=enabled/disabled`，**默认 enabled** |
| 思考强度 | `reasoning_effort` 仅 `high` / `max` 两档有效（`low`/`medium`→`high`，`xhigh`→`max`）；默认 `high` |
| 温度坑 | **思考模式下 `temperature`/`top_p`/`presence_penalty`/`frequency_penalty` 一律被忽略**（不报错、静默无效） |
| 工具调用坑 | 思考模式支持工具调用；但**发生工具调用的回合，`reasoning_content` 必须原样回传**，缺失则 API 返回 400 |
| 上下文 | 实际 1M；建议收窄到 64K 控成本 |
| API Key 来源 | **内测期默认 BYOK**：key 由用户自带、按 turn 解析注入（`llm/resolve.py` `resolve_user_llm_credentials` → `factory.build_provider(credentials)`），非全局 `platform_api_key`。平台付费/全局 key 路径靠 `config.billing_mode` 休眠（默认 `byok`），详见 [`docs/05-平台与运维/成本配额与计费.md` §〇·五](../../docs/05-平台与运维/成本配额与计费.md) |

### Provider 路由规则

1. 精确匹配: 模型名注册在某个 provider → 路由到该 provider
2. 前缀匹配: `provider_name/model` → 路由到 `provider_name`, 实际模型取 `/` 后部分
3. 回退: 路由到 default provider

### 思考强度按角色分档

| 角色 | thinking / effort |
|---|---|
| CEO 主 Agent（对话 + 按需 `delegate`，走 `chat` 档） | 思考 on，`high`（`max` 由 per-agent 按需解锁） |
| worker 两档（`fast`/`strong`）、单聊 | 思考 on，`high`；`max` 由 per-agent 覆盖按需解锁 |
| 标题 / 记忆维护（后台机械任务） | **非思考**（提速省钱） |

> 开发期统一为「`high`/`max` 两档有效思考强度」，不再有非思考的 worker 档；`fast` 与 `strong` 同为 `high`，靠回合预算（8 vs 28）+ `max` 解锁区分。非思考只保留给标题/记忆这类后台机械任务。

per-agent 可在版本配置里声明 `thinking`（bool）/ `reasoning_effort`（`high`/`max`）覆盖角色默认（只升不降）。

### 档位设计决策（被否决方案）

worker 档位经一轮收敛（2026-06-14），保留关键否决理由：

- **删 `standard`，收敛为 `fast`/`strong` 两档**：二选一对 CEO `delegate` 更可靠，且对齐 DeepSeek 模型分层意图。
- **单聊不吃 worker 档，固定独立 `chat` 档**：单聊最高频、体验需稳定可预期；将来 `strong` 翻 Pro 不连累单聊。
- **撤销「`fast` 非思考」，`fast` 同为思考 `high`**：开发期统一 `high`/`max` 两档有效强度，`fast` 靠小回合预算（8 轮）区分「更快更省」。
- **强档 effort 锁 `high`，`max` 仅由 per-agent 覆盖按需解锁且只升不降**：`max` 需 384K+ 窗口且更贵，不当默认；只升不降防乱关思考 / 乱降档。

---

## 上游规格速览（价格 / 参数表以官方为准，本文不复述）

> **官方文档**：https://api-docs.deepseek.com（模型参数、完整价格表、功能矩阵均可查，截至 2026-06-14 核对过）。AgentCore 角色映射见 [执行引擎 §六](/docs/03-AI核心/执行引擎架构设计.md) 与 [术语表](/docs/01-产品/术语表.md)。

- **两档模型**：`deepseek-v4-flash`（284B MoE，高并发 / 日常）/ `deepseek-v4-pro`（1.6T MoE，复杂推理 / Agent）；均 1M 上下文、384K 最大输出、MIT 开源。旧名 `deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 停用。
- **价格量级**：Flash 输入 $0.14/1M（**缓存命中 $0.0028——50 倍价差**）、输出 $0.28/1M；Pro 约 3 倍。前缀缓存纪律是成本生命线（见 [执行引擎 §三 缓存铁律](/docs/03-AI核心/执行引擎架构设计.md)）。
- **并发上限**：Flash 2,500 / Pro 500——Multi-Agent 宽扇出注意 Pro 上限。
- 另有 Anthropic 格式端点 `https://api.deepseek.com/anthropic`（字段名不同，见官方）。

## 开发易错点（速查表之外的补充）

1. **`reasoning_content` 回传惯用法**：直接 `messages.append(response.choices[0].message)`（自动含 `reasoning_content`）；**无 tool call** 的多轮不需要传回（传了被忽略），**有 tool call** 的轮次缺失即 400（速查表已列）。
2. **不支持强制 `tool_choice`**：模型自主决定是否调用。运行时对话只发 `auto`/`none`；BYOK `probe_tools` 先试一次 `required`、遇 400 回退省略（见 `OpenAICompatibleProvider.probe_tools`）。
3. **不支持 `developer` role**：只支持 `system` / `user` / `assistant` / `tool`。
4. **`max` 档需 ≥384K 上下文窗口**；FIM 补全仅非思考模式（Beta）。
5. **推荐采样**：`temperature=1.0, top_p=1.0`（所有模式通用；思考模式下采样参数本就被忽略，见速查表）。
