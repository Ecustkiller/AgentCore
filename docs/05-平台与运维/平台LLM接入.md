# 平台 LLM 接入

## 当前架构

```
AgentCore Server
    │
    │  POST /v1/chat/completions (OpenAI 兼容格式)
    ▼
codex_chat_proxy (localhost:9090)
    │
    │  翻译为 Responses API 格式
    │  POST https://chatgpt.com/backend-api/codex/responses
    ▼
ChatGPT Codex 后端 (OpenAI)
```

系统通过本地代理 `scripts/codex_chat_proxy.py` 连接 ChatGPT Codex 后端。代理接收标准 OpenAI chat/completions 请求，翻译为 Codex Responses API 格式，发送到 ChatGPT 后端，再将响应翻译回 chat/completions 格式返回。

## 为什么不用 Sub2API

此前使用 Sub2API（本地 OpenAI 兼容网关），但账号为 K-12 教育计划（`chatgpt_plan_type: k12`），Sub2API 硬性拒绝 K-12 账号的 chat/completions 请求。K-12 账号设计用途是 Codex CLI，原生支持的端点是 `chatgpt.com/backend-api/codex/responses`，而非标准 OpenAI API。

因此改为直连 Codex 后端，绕过 Sub2API 的限制。

## 可用模型

K-12 Codex 账号**仅支持以下模型**：

| 模型 slug | 说明 |
|-----------|------|
| `gpt-5.4` | Codex 专用 agentic 模型 |
| `gpt-5.5` | Codex 最新模型（当前默认） |

通用 ChatGPT 模型名（`gpt-4o`、`o4-mini`、`gpt-4.1` 等）会被 Codex 后端拒绝。

## 配置

### 环境变量 (`.env`)

```env
PLATFORM_API_KEY=sk-xxx          # 任意非空字符串即可（代理不校验）
PLATFORM_BASE_URL=http://localhost:9090/v1
PLATFORM_MODEL=gpt-5.5
BILLING_MODE=platform
```

### 凭证文件

`config/codex-credentials.json`：

```json
{
  "email": "xxx@outlook.com",
  "account_id": "uuid",
  "access_token": "JWT token (从 CPA 工具获取)",
  "expires_at": "过期时间",
  "note": "说明"
}
```

代理启动时从此文件读取 `access_token`，用于向 ChatGPT 后端认证。

## 启动与运行

```bash
# 1. 启动代理（保持运行）
python scripts/codex_chat_proxy.py --port 9090

# 2. 启动 AgentCore
uv run python -m agentcore
```

代理会输出：
```
Loaded credentials for xxx@outlook.com
Listening on http://127.0.0.1:9090/v1/chat/completions
Upstream: https://chatgpt.com/backend-api/codex/responses
```

## 代理工作原理

`scripts/codex_chat_proxy.py` 做以下事情：

1. **接收**：`POST /v1/chat/completions`（标准 OpenAI 格式，含 messages 数组）
2. **翻译**：将 messages 转为 Responses API 的 `input` 格式（每条 message 包装为 `{type: "message", role, content: [{type: "input_text", text}]}`）
3. **转发**：发送到 `https://chatgpt.com/backend-api/codex/responses`，带 Bearer token 和 `ChatGPT-Account-ID` header
4. **解析**：读取 SSE 流，提取 `response.output_text.delta` 事件中的文本
5. **返回**：
   - 非流式：返回完整的 chat completion JSON
   - 流式：返回 SSE 格式的 chat completion chunks

## Token 刷新

access_token 是 JWT，有过期时间（通常约 10 天）。过期后需要用 CPA 工具重新获取 token，更新 `config/codex-credentials.json` 并重启代理。

检查 token 是否过期：看 JWT 的 `exp` claim，或代理返回 401/403 错误时即需刷新。

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| 代理返回 502 upstream_error | Token 过期或上游故障 | 刷新 token |
| 400 "model not supported when using Codex" | 使用了非 Codex 模型名 | 改用 `gpt-5.4` / `gpt-5.5` |
| AgentCore 503 "平台服务端错误" | 代理未启动 | 启动 `codex_chat_proxy.py` |
| 连接被拒 | 代理未启动或端口不对 | 检查 9090 端口 |

## 未来演进

- Token 自动刷新机制（当前需手动）
- 支持多账号轮转/负载均衡
- 接入其他 LLM 提供商作为备用（DeepSeek、OpenRouter 等）
- 当获得非 K-12 账号后，可考虑直连 OpenAI API 去掉代理层
