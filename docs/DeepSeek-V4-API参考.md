# DeepSeek V4 API 开发参考

> **用途**：供 AI Agent 开发时查阅的技术参考，包含模型参数、API 调用方式、注意事项。
> **数据来源**：DeepSeek 官方 API 文档（api-docs.deepseek.com），截至 2026-06-14。
> **官方文档**：https://api-docs.deepseek.com

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

### 在 AgentCore 中的角色分配

| AgentCore 角色 | 模型 | 思考模式 |
|---------------|------|---------|
| 编排器（含检查点复核） | deepseek-v4-flash | 思考模式 (max) |
| `fast` 档 worker（较简单 / 范围明确） | deepseek-v4-flash | 思考模式 (high)、回合预算小 |
| `strong` 档 worker、单聊、合成 | deepseek-v4-flash（strong 设计本意 Pro，开发期暂走 Flash） | 思考模式 (high) |
| 极复杂任务（per-agent 按需解锁） | deepseek-v4-flash | 思考模式 (max) |
| 标题 / 记忆维护（后台机械任务） | deepseek-v4-flash | 非思考（提速省钱） |

> 开发期统一为「`high`/`max` 两档有效思考强度 + 后台机械任务非思考」，全部走 Flash。`fast` 与 `strong` 同为 `high`，靠回合预算（4 vs 28）与 per-agent `max` 解锁区分；不再保留非思考的 worker 档。

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

## 七、代码示例

### 7.1 基础调用（非思考模式，适用于 fast 档 worker / 标题 / 记忆）

```python
from openai import OpenAI

client = OpenAI(
    api_key="<DEEPSEEK_API_KEY>",
    base_url="https://api.deepseek.com"
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "用一句话给这段对话起个标题"}],
    extra_body={"thinking": {"type": "disabled"}},
)
```

### 7.2 思考模式调用（适用于编排器 / Worker Agent）

```python
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "实现一个 LRU 缓存"}],
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
)

reasoning = response.choices[0].message.reasoning_content
answer = response.choices[0].message.content
```

### 7.3 带 Tool Call 的完整循环

```python
def run_agent_turn(client, messages, tools, model="deepseek-v4-pro"):
    """执行一轮 Agent 交互，处理所有 tool call 直到得到最终回复。"""
    while True:
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tools,
            reasoning_effort="high",
            extra_body={"thinking": {"type": "enabled"}},
        )
        
        assistant_msg = response.choices[0].message
        messages.append(assistant_msg)  # 自动包含 reasoning_content
        
        if assistant_msg.tool_calls is None:
            return assistant_msg.content
        
        for tool_call in assistant_msg.tool_calls:
            result = execute_tool(tool_call.function.name, tool_call.function.arguments)
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": str(result),
            })
```

### 7.4 流式输出

```python
stream = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=messages,
    stream=True,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
)

for chunk in stream:
    delta = chunk.choices[0].delta
    if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
        print(f"[思考] {delta.reasoning_content}", end="")
    if delta.content:
        print(delta.content, end="")
```

---

## 八、Agent 基准性能（2026-04-24 发布数据）

| 基准 | V4-Flash-Max | V4-Pro-Max | Opus 4.6-Max | GPT-5.4-xHigh |
|------|-------------|-----------|-------------|---------------|
| SWE Verified | 79.0 | 80.6 | 80.8 | — |
| MCPAtlas Public | — | 73.6 | 73.8 | — |
| Terminal Bench 2.0 | — | 67.9 | — | 75.1 |
| MMLU-Pro | 86.2 | 87.5 | — | — |
| LiveCodeBench | 91.6 | 93.5 | — | — |
| Toolathlon | — | 51.8 | — | — |

---

## 九、开发注意事项

1. **reasoning_content 必须回传**：这是 V4 与其他模型最大的 API 差异。在 tool call 场景中，如果前一轮有 reasoning_content 且该轮包含 tool_calls，后续所有请求都必须包含它。

2. **思考模式默认启用**：如果不需要思考（如标题生成 / 记忆维护 / fast 档 worker），必须显式设置 `{"thinking": {"type": "disabled"}}`。

3. **缓存命中**：DeepSeek 服务端自动做 prompt prefix caching，相同前缀的请求会命中缓存，输入价格大幅降低（Flash: $0.14 → $0.0028）。多轮对话场景天然受益。

4. **并发限制**：Flash 2,500 并发 / Pro 500 并发。Multi-Agent 场景下注意 Pro 的并发上限。

5. **不支持 tool_choice**：V4 不支持 `tool_choice` 参数（强制使用某个工具），模型自主决定是否调用工具。

6. **不支持 developer role**：不支持 OpenAI 的 `developer` role，只支持 `system`、`user`、`assistant`、`tool`。

7. **FIM 仅非思考模式**：Fill-in-the-Middle 补全只在非思考模式下可用。

8. **max 模式需大窗口**：`reasoning_effort="max"` 至少需要 384K 上下文窗口，适用于极复杂任务。
