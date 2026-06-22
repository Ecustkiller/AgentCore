---
status: reference
code: ""
related:
  - .cursor/rules/llm.mdc
  - docs/03-AI核心/执行引擎架构设计.md
skip_if:
  - 只改 AgentCore 内部行为（读 llm.mdc / 03-AI）
---

# DeepSeek V4 API 开发参考

> **用途**：供 AI Agent 开发时查阅的技术参考，包含模型参数、API 调用方式、注意事项。
> **数据来源**：DeepSeek 官方 API 文档（api-docs.deepseek.com），截至 2026-06-14。
> **官方文档**：https://api-docs.deepseek.com

→ AgentCore 角色映射见 [/docs/03-AI核心/执行引擎架构设计.md §六](/docs/03-AI核心/执行引擎架构设计.md) 与 [/docs/01-产品/术语表.md](/docs/01-产品/术语表.md)

---

## 一、模型概览

| 规格 | deepseek-v4-flash | deepseek-v4-pro |
|------|-------------------|-----------------|
| 总参数 | 284B | 1.6T |
| 激活参数（MoE） | 13B | 49B |
| 架构 | Mixture-of-Experts (MoE) | Mixture-of-Experts (MoE) |
| 上下文窗口 | **1,000,000 tokens** | **1,000,000 tokens** |
| 最大输出 | 384,000 tokens | 384,000 tokens |
| 开源协议 | MIT | MIT |
| 定位 | 高并发、路由、日常对话 | 复杂推理、Agent、专业编码 |

---

## 二、API 连接信息

| 项目 | 值 |
|------|---|
| Base URL（OpenAI 格式） | `https://api.deepseek.com` |
| Base URL（Anthropic 格式） | `https://api.deepseek.com/anthropic` |
| 认证方式 | Bearer Token（`Authorization: Bearer <API_KEY>`） |
| 模型名（Flash） | `deepseek-v4-flash` |
| 模型名（Pro） | `deepseek-v4-pro` |

> **注意**：旧模型名 `deepseek-chat` 和 `deepseek-reasoner` 将于 **2026-07-24 15:59 UTC** 停用。
> 目前它们分别指向 deepseek-v4-flash 的非思考模式和思考模式。

---

## 三、价格（截至 2026-06-14）

| 计费项 | V4-Flash | V4-Pro |
|--------|----------|--------|
| 输入/1M tokens（缓存命中） | $0.0028 | $0.003625 |
| 输入/1M tokens（缓存未命中） | $0.14 | $0.435 |
| 输出/1M tokens | $0.28 | $0.87 |
| 并发限制 | 2,500 | 500 |

---

## 四、思考模式（Thinking Mode）

### 4.1 切换与控制

思考模式**默认启用**。通过以下参数控制：

| 参数 | OpenAI 格式 | Anthropic 格式 |
|------|------------|---------------|
| 开关 | `extra_body={"thinking": {"type": "enabled"}}` 或 `"disabled"` | `{"thinking": {"type": "enabled"}}` 或 `"disabled"` |
| 强度 | `reasoning_effort="high"` 或 `"max"` | `{"output_config": {"effort": "high"}}` 或 `"max"` |

强度映射规则：
- `low` / `medium` → 映射为 `high`
- `xhigh` → 映射为 `max`
- 默认：`high`（复杂 Agent 请求如 Claude Code、OpenCode 自动设为 `max`）

### 4.2 思考模式限制

- **不支持** `temperature`、`top_p`、`presence_penalty`、`frequency_penalty`（设了不报错但无效）
- `max` 模式需要上下文窗口 **至少 384K tokens**
- 推荐采样参数：`temperature=1.0, top_p=1.0`（所有模式通用）

### 4.3 思考内容的处理

- 思考内容通过 `reasoning_content` 字段返回，与 `content` 同级
- **无 tool call 的多轮对话**：前一轮的 `reasoning_content` 不需要传回（传了也会被忽略）
- **有 tool call 的多轮对话**：`reasoning_content` **必须完整传回**，否则 **400 报错**

---

## 五、功能支持

| 功能 | V4-Flash | V4-Pro |
|------|----------|--------|
| JSON Output | ✅ | ✅ |
| Tool Calls | ✅ | ✅ |
| Chat Prefix Completion（Beta） | ✅ | ✅ |
| FIM Completion（Beta） | 仅非思考模式 | 仅非思考模式 |
| 流式输出（Streaming） | ✅ | ✅ |
| 多轮对话 | ✅ | ✅ |

---

## 六、Tool Call 调用规范

### 6.1 工具定义格式

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "tool_name",
            "description": "工具描述",
            "parameters": {
                "type": "object",
                "properties": {
                    "param1": {
                        "type": "string",
                        "description": "参数描述"
                    }
                },
                "required": ["param1"]
            }
        }
    }
]
```

### 6.2 Tool Call 循环模式

```
用户消息
  → 模型推理 (reasoning_content) + tool_calls
    → 执行工具，返回 tool 消息
      → 模型继续推理 + 可能再次 tool_calls
        → ... 循环直到模型返回 content 且 tool_calls=None
```

### 6.3 关键：reasoning_content 回传

```python
# 正确做法：直接 append response message（自动包含 reasoning_content）
messages.append(response.choices[0].message)

# 等价于：
messages.append({
    'role': 'assistant',
    'content': response.choices[0].message.content,
    'reasoning_content': response.choices[0].message.reasoning_content,
    'tool_calls': response.choices[0].message.tool_calls,
})
```

**⚠️ 如果 tool call 轮次中丢失 reasoning_content，API 返回 400 错误。**

### 6.4 Tool 响应格式

```python
messages.append({
    "role": "tool",
    "tool_call_id": tool_call.id,
    "content": "工具执行结果（字符串）",
})
```

---

## 七、开发注意事项

1. **reasoning_content 必须回传**：这是 V4 与其他模型最大的 API 差异。在 tool call 场景中，如果前一轮有 reasoning_content 且该轮包含 tool_calls，后续所有请求都必须包含它。

2. **思考模式默认启用**：如果不需要思考（如标题生成 / 记忆维护等后台机械任务），必须显式设置 `{"thinking": {"type": "disabled"}}`。

3. **缓存命中**：DeepSeek 服务端自动做 prompt prefix caching，相同前缀的请求会命中缓存，输入价格大幅降低（Flash: $0.14 → $0.0028）。多轮对话场景天然受益。

4. **并发限制**：Flash 2,500 并发 / Pro 500 并发。Multi-Agent 场景下注意 Pro 的并发上限。

5. **不支持 tool_choice**：V4 不支持 `tool_choice` 参数（强制使用某个工具），模型自主决定是否调用工具。

6. **不支持 developer role**：不支持 OpenAI 的 `developer` role，只支持 `system`、`user`、`assistant`、`tool`。

7. **FIM 仅非思考模式**：Fill-in-the-Middle 补全只在非思考模式下可用。

8. **max 模式需大窗口**：`reasoning_effort="max"` 至少需要 384K 上下文窗口，适用于极复杂任务。
