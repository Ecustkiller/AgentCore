"""DeepSeek V4 LLM provider implementation.

Supports:
- Streaming SSE responses (data: [DONE] termination)
- Thinking mode with reasoning_content extraction
- Tool calling with reasoning_content passthrough
- Retry with exponential backoff on 429 and 5xx
"""

import json
import time
from collections.abc import AsyncIterator

import httpx

from agentcore.core.errors import LLMError, LLMRateLimitError, LLMTimeoutError
from agentcore.core.logging import get_logger
from agentcore.core.types import ModelTier
from agentcore.llm.config import DEFAULT_MODEL_MAPPING, ModelMapping, resolve_model_for_tier
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


class DeepSeekProvider:
    """DeepSeek V4 API implementation of LLMProvider."""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com",
        model_mapping: ModelMapping | None = None,
    ):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model_mapping = model_mapping or DEFAULT_MODEL_MAPPING
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(_REQUEST_TIMEOUT, connect=10.0),
        )

    async def complete(self, request: LLMRequest) -> LLMResponse:
        """Non-streaming LLM call."""
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

        usage_data = data.get("usage", {})
        usage = TokenUsage(
            input_tokens=usage_data.get("prompt_tokens", 0),
            output_tokens=usage_data.get("completion_tokens", 0),
            reasoning_tokens=usage_data.get("completion_tokens_details", {}).get(
                "reasoning_tokens", 0
            ),
            cache_hit_tokens=usage_data.get("prompt_cache_hit_tokens", 0),
            cache_miss_tokens=usage_data.get("prompt_cache_miss_tokens", 0),
        )

        return LLMResponse(
            content=message.get("content") or "",
            reasoning_content=message.get("reasoning_content"),
            tool_calls=tool_calls,
            usage=usage,
            finish_reason=choice.get("finish_reason", "stop"),
            model=data.get("model", request.model),
            latency_ms=latency_ms,
        )

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        """Streaming LLM call. Yields chunks as they arrive from SSE."""
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

            choice = data.get("choices", [{}])[0]
            delta = choice.get("delta", {})

            # Parse tool call deltas
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

            # Parse usage from the final chunk
            usage = None
            if data.get("usage"):
                u = data["usage"]
                usage = TokenUsage(
                    input_tokens=u.get("prompt_tokens", 0),
                    output_tokens=u.get("completion_tokens", 0),
                    reasoning_tokens=u.get("completion_tokens_details", {}).get(
                        "reasoning_tokens", 0
                    ),
                    cache_hit_tokens=u.get("prompt_cache_hit_tokens", 0),
                    cache_miss_tokens=u.get("prompt_cache_miss_tokens", 0),
                )

            yield LLMChunk(
                delta_content=delta.get("content"),
                delta_reasoning=delta.get("reasoning_content"),
                delta_tool_calls=tc_deltas,
                finish_reason=choice.get("finish_reason"),
                usage=usage,
            )

    def resolve_model(self, tier: ModelTier) -> str:
        """Map ModelTier to concrete model identifier."""
        return resolve_model_for_tier(tier, self._model_mapping)

    def _build_payload(self, request: LLMRequest, *, stream: bool) -> dict:
        """Build the API request payload from LLMRequest."""
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
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in msg.tool_calls
                ]
            if msg.tool_call_id:
                m["tool_call_id"] = msg.tool_call_id
            if msg.reasoning_content:
                m["reasoning_content"] = msg.reasoning_content
            messages.append(m)

        payload: dict = {
            "model": request.model,
            "messages": messages,
            "stream": stream,
        }

        if request.max_tokens:
            payload["max_tokens"] = request.max_tokens

        if request.tools:
            payload["tools"] = request.tools
            payload["tool_choice"] = request.tool_choice

        # Thinking mode configuration (per llm.mdc)
        if request.thinking is not None:
            if request.thinking:
                payload["extra_body"] = {"thinking": {"type": "enabled"}}
                # Temperature is ignored in thinking mode per API constraint
            else:
                payload["extra_body"] = {"thinking": {"type": "disabled"}}
                payload["temperature"] = request.temperature
        else:
            payload["temperature"] = request.temperature

        if request.reasoning_effort and request.thinking is not False:
            payload.setdefault("extra_body", {})
            payload["extra_body"]["reasoning_effort"] = request.reasoning_effort

        if stream:
            payload["stream_options"] = {"include_usage": True}

        return payload

    async def _request_with_retry(self, payload: dict) -> dict:
        """Make a non-streaming request with retry logic."""
        last_error: Exception | None = None
        backoff = _INITIAL_BACKOFF

        for attempt in range(_MAX_RETRIES):
            try:
                response = await self._client.post("/v1/chat/completions", json=payload)

                if response.status_code == 429:
                    retry_after = float(response.headers.get("retry-after", backoff))
                    raise LLMRateLimitError(retry_after=retry_after)

                if response.status_code >= 500:
                    raise LLMError(f"Server error: {response.status_code}")

                response.raise_for_status()
                return response.json()

            except (LLMRateLimitError, LLMError) as e:
                last_error = e
                if not e.retryable or attempt == _MAX_RETRIES - 1:
                    raise
                retry_after = e.retry_after if isinstance(e, LLMRateLimitError) else None
                wait = retry_after or backoff
                logger.warning(
                    "llm_retry",
                    attempt=attempt + 1,
                    wait_seconds=wait,
                    error=str(e),
                )
                import asyncio
                await asyncio.sleep(wait)
                backoff *= _BACKOFF_MULTIPLIER

            except httpx.TimeoutException as e:
                last_error = LLMTimeoutError(str(e))
                if attempt == _MAX_RETRIES - 1:
                    raise last_error from e
                logger.warning("llm_timeout_retry", attempt=attempt + 1)
                import asyncio
                await asyncio.sleep(backoff)
                backoff *= _BACKOFF_MULTIPLIER

        raise last_error or LLMError("Unexpected retry exhaustion")

    async def _stream_with_retry(self, payload: dict) -> AsyncIterator[str]:
        """Make a streaming request, yielding SSE lines. Retries on transient errors."""
        last_error: Exception | None = None
        backoff = _INITIAL_BACKOFF

        for attempt in range(_MAX_RETRIES):
            try:
                async with self._client.stream(
                    "POST", "/v1/chat/completions", json=payload
                ) as response:
                    if response.status_code == 429:
                        retry_after = float(response.headers.get("retry-after", backoff))
                        raise LLMRateLimitError(retry_after=retry_after)

                    if response.status_code >= 500:
                        raise LLMError(f"Server error: {response.status_code}")

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
                logger.warning("llm_stream_retry", attempt=attempt + 1, wait_seconds=wait)
                import asyncio
                await asyncio.sleep(wait)
                backoff *= _BACKOFF_MULTIPLIER

            except httpx.TimeoutException as e:
                last_error = LLMTimeoutError(str(e))
                if attempt == _MAX_RETRIES - 1:
                    raise last_error from e
                import asyncio
                await asyncio.sleep(backoff)
                backoff *= _BACKOFF_MULTIPLIER

        raise last_error or LLMError("Unexpected retry exhaustion")

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()
