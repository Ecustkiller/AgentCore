"""Generic OpenAI-compatible LLM provider (Kimi / 智谱 GLM / 豆包 Ark / …）。

国内主流大模型几乎都暴露 OpenAI 兼容的 ``/chat/completions`` 接口（仅换 base_url +
api_key + model 名）。本 provider 把这套「标准 OpenAI 形状」收敛成一个可复用实现，供
:class:`~agentcore.llm.router.ProviderRouter` 按 ``provider/model`` 前缀分发到不同厂商
（辩论编排「真·多模型辩手」的执行地基）。

与 :class:`~agentcore.llm.deepseek.DeepSeekProvider` 的差异（刻意保持后者不动，零回归）：

- **只发标准字段**（model / messages / stream / temperature / max_tokens / tools）。
  DeepSeek 特有的 ``thinking`` / ``reasoning_effort`` 一律不发——这些字段在别家网关上可能
  报 400，且各厂商的「思考」开关并不统一（思考型模型如 kimi-k2.6 默认即推理）。需要分厂商
  细调思考时再加 per-provider 旋钮。
- **usage 用标准 OpenAI 键**（``prompt_tokens`` / ``completion_tokens`` /
  ``completion_tokens_details.reasoning_tokens``）；DeepSeek 的 prefix-cache 拆分键不存在
  时记 0，由 :func:`~agentcore.llm.pricing.calculate_cost` 把整段 prompt 当 cache_miss 计价
  （已内建该对账，见其文档），账目不会凭空消失。
- **错误信息泛化**（带厂商展示名），不再写死「DeepSeek」。

``base_url`` 须已含版本前缀（如 ``https://api.moonshot.cn/v1``、
``https://open.bigmodel.cn/api/paas/v4``、``https://ark.cn-beijing.volces.com/api/v3``），
本类对其拼接相对路径 ``chat/completions``。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator

import httpx

from agentcore.core.errors import (
    LLMAuthError,
    LLMError,
    LLMInsufficientBalanceError,
    LLMRateLimitError,
    LLMTimeoutError,
)
from agentcore.core.logging import get_logger
from agentcore.llm.observability import log_llm_call
from agentcore.llm.protocol import (
    LLMChunk,
    LLMRequest,
    LLMResponse,
    TokenUsage,
    ToolCall,
    ToolCallDelta,
    ToolCallFunction,
)

logger = get_logger(__name__)

_MAX_RETRIES = 3
_INITIAL_BACKOFF = 1.0
_BACKOFF_MULTIPLIER = 2.0
_REQUEST_TIMEOUT = 120.0


def _usage_from(usage_data: dict) -> TokenUsage:
    """Parse an OpenAI-standard ``usage`` block (cache split absent → 0)."""
    details = usage_data.get("completion_tokens_details") or {}
    return TokenUsage(
        input_tokens=usage_data.get("prompt_tokens", 0),
        output_tokens=usage_data.get("completion_tokens", 0),
        reasoning_tokens=details.get("reasoning_tokens", 0),
        # 标准 OpenAI 不返回 DeepSeek 的 prefix-cache 拆分；缺失记 0，calculate_cost 会把
        # 整段 input 当 cache_miss 计价（其文档「Cache-split reconciliation」段）。
        cache_hit_tokens=usage_data.get("prompt_cache_hit_tokens", 0),
        cache_miss_tokens=usage_data.get("prompt_cache_miss_tokens", 0),
    )


class OpenAICompatibleProvider:
    """OpenAI-compatible ``/chat/completions`` provider for non-DeepSeek vendors.

    ``name`` 是路由前缀（``kimi`` / ``zhipu`` / ``doubao``）兼日志/错误展示名；``base_url``
    须含版本前缀。实现 :class:`~agentcore.llm.protocol.LLMProvider` 的 ``complete`` /
    ``stream``，可直接当作执行器的 ``llm`` 注入（经路由器）。
    """

    def __init__(
        self,
        *,
        name: str,
        api_key: str,
        base_url: str,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self._name = name
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers=headers,
            timeout=httpx.Timeout(_REQUEST_TIMEOUT, connect=10.0),
        )

    @property
    def name(self) -> str:
        return self._name

    async def complete(self, request: LLMRequest) -> LLMResponse:
        payload = self._build_payload(request, stream=False)
        start = time.monotonic()
        data = await self._request_with_retry(payload)
        latency_ms = int((time.monotonic() - start) * 1000)

        choice = data["choices"][0]
        message = choice["message"]
        tool_calls = None
        if message.get("tool_calls"):
            tool_calls = [
                ToolCall(
                    id=tc["id"],
                    function=ToolCallFunction(
                        name=tc["function"]["name"],
                        arguments=tc["function"]["arguments"],
                    ),
                )
                for tc in message["tool_calls"]
            ]
        usage = _usage_from(data.get("usage", {}))
        response = LLMResponse(
            content=message.get("content") or "",
            reasoning_content=message.get("reasoning_content"),
            tool_calls=tool_calls,
            usage=usage,
            finish_reason=choice.get("finish_reason", "stop"),
            model=data.get("model", request.model),
            latency_ms=latency_ms,
        )
        log_llm_call(
            scenario=request.scenario,
            model=response.model,
            usage=usage,
            finish_reason=response.finish_reason,
            latency_ms=latency_ms,
            stream=False,
            messages=request.messages,
            content=response.content,
            reasoning=response.reasoning_content,
        )
        return response

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        payload = self._build_payload(request, stream=True)
        async for line in self._stream_with_retry(payload):
            if not line.startswith("data: "):
                continue
            data_str = line[6:]
            if data_str.strip() == "[DONE]":
                return
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            choices = data.get("choices") or [{}]
            choice = choices[0]
            delta = choice.get("delta", {})
            tc_deltas = None
            if delta.get("tool_calls"):
                tc_deltas = [
                    ToolCallDelta(
                        index=tc.get("index", 0),
                        id=tc.get("id"),
                        function_name=tc.get("function", {}).get("name"),
                        arguments_delta=tc.get("function", {}).get("arguments"),
                    )
                    for tc in delta["tool_calls"]
                ]
            usage = _usage_from(data["usage"]) if data.get("usage") else None
            yield LLMChunk(
                delta_content=delta.get("content"),
                delta_reasoning=delta.get("reasoning_content"),
                delta_tool_calls=tc_deltas,
                finish_reason=choice.get("finish_reason"),
                usage=usage,
            )

    def _build_payload(self, request: LLMRequest, *, stream: bool) -> dict:
        """Standard OpenAI Chat Completions payload (no vendor-specific extras)."""
        messages = []
        for msg in request.messages:
            m: dict = {"role": msg.role}
            if msg.content is not None:
                m["content"] = msg.content
            if msg.tool_calls:
                m["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in msg.tool_calls
                ]
            if msg.tool_call_id:
                m["tool_call_id"] = msg.tool_call_id
            # 注意：不回传 reasoning_content。DeepSeek 思考模式要求工具回合原样回传 reasoning，
            # 但这是 DeepSeek 特有约束；通用 OpenAI 端点不需要、部分还会拒收。
            messages.append(m)

        payload: dict = {
            "model": request.model,
            "messages": messages,
            "stream": stream,
            "temperature": request.temperature,
        }
        if request.max_tokens:
            payload["max_tokens"] = request.max_tokens
        if request.tools:
            payload["tools"] = request.tools
            payload["tool_choice"] = request.tool_choice
        if stream:
            payload["stream_options"] = {"include_usage": True}
        return payload

    def _raise_for_status(self, status_code: int, backoff: float, headers) -> None:
        """Map an HTTP status to a typed, retryable-aware error (shared by both paths)."""
        if status_code == 429:
            retry_after = float(headers.get("retry-after", backoff))
            raise LLMRateLimitError(retry_after=retry_after)
        if status_code in (401, 403):
            raise LLMAuthError()
        if status_code == 402:
            raise LLMInsufficientBalanceError()
        if status_code >= 500:
            raise LLMError(f"{self._name} 服务端错误（{status_code}），请稍后再试")

    async def _request_with_retry(self, payload: dict) -> dict:
        last_error: Exception | None = None
        backoff = _INITIAL_BACKOFF
        for attempt in range(_MAX_RETRIES):
            try:
                response = await self._client.post("/chat/completions", json=payload)
                self._raise_for_status(response.status_code, backoff, response.headers)
                response.raise_for_status()
                return response.json()
            except (LLMRateLimitError, LLMError) as e:
                last_error = e
                if not e.retryable or attempt == _MAX_RETRIES - 1:
                    raise
                retry_after = e.retry_after if isinstance(e, LLMRateLimitError) else None
                wait = retry_after or backoff
                logger.warning("llm.retry", provider=self._name, attempt=attempt + 1, wait=wait)
                await asyncio.sleep(wait)
                backoff *= _BACKOFF_MULTIPLIER
            except httpx.TimeoutException as e:
                last_error = LLMTimeoutError(f"连接 {self._name} 超时，请检查网络后重试")
                if attempt == _MAX_RETRIES - 1:
                    raise last_error from e
                logger.warning("llm.timeout_retry", provider=self._name, attempt=attempt + 1)
                await asyncio.sleep(backoff)
                backoff *= _BACKOFF_MULTIPLIER
        raise last_error or LLMError(f"{self._name} 多次重试后仍失败，请稍后重试")

    async def _stream_with_retry(self, payload: dict) -> AsyncIterator[str]:
        last_error: Exception | None = None
        backoff = _INITIAL_BACKOFF
        for attempt in range(_MAX_RETRIES):
            try:
                async with self._client.stream(
                    "POST", "/chat/completions", json=payload
                ) as response:
                    self._raise_for_status(response.status_code, backoff, response.headers)
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        yield line
                    return
            except (LLMRateLimitError, LLMError) as e:
                last_error = e
                if not e.retryable or attempt == _MAX_RETRIES - 1:
                    raise
                retry_after = e.retry_after if isinstance(e, LLMRateLimitError) else None
                wait = retry_after or backoff
                logger.warning(
                    "llm.stream_retry", provider=self._name, attempt=attempt + 1, wait=wait
                )
                await asyncio.sleep(wait)
                backoff *= _BACKOFF_MULTIPLIER
            except httpx.TimeoutException as e:
                last_error = LLMTimeoutError(f"连接 {self._name} 超时，请检查网络后重试")
                if attempt == _MAX_RETRIES - 1:
                    raise last_error from e
                await asyncio.sleep(backoff)
                backoff *= _BACKOFF_MULTIPLIER
        raise last_error or LLMError(f"{self._name} 多次重试后仍失败，请稍后重试")

    async def probe(self, *, model: str) -> None:
        """One minimal call to verify the key + endpoint reach this vendor's model.

        Mirrors :meth:`DeepSeekProvider.probe` (BYOK「测试连接」语义)：2xx / 429 →
        可达且鉴权通过；401/403 → 坏 key；402 → 余额不足；404 → 端点不可达；5xx → 上游错。
        无重试（连通测试须快且确定）。
        """
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "stream": False,
        }
        try:
            response = await self._client.post("/chat/completions", json=payload)
        except httpx.TimeoutException as e:
            raise LLMTimeoutError(f"连接 {self._name} 超时，请检查网络后重试") from e
        except httpx.HTTPError as e:
            raise LLMError(f"无法连接 {self._name}：{e}") from e
        code = response.status_code
        if code < 300 or code == 429:
            return
        if code in (401, 403):
            raise LLMError(f"{self._name} API Key 无效或无权限（鉴权失败），请检查后重试")
        if code == 402:
            raise LLMInsufficientBalanceError(
                f"{self._name} API Key 有效，但账户余额不足，请充值后使用。"
            )
        if code == 404:
            raise LLMError(f"{self._name} 接口地址不可达（404），请检查 base_url 配置")
        if code >= 500:
            raise LLMError(f"{self._name} 服务端错误（{code}），请稍后再试")
        raise LLMError(f"{self._name} 连通测试失败（HTTP {code}）")

    async def close(self) -> None:
        await self._client.aclose()
