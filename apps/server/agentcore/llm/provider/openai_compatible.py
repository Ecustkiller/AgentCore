"""Generic OpenAI-compatible LLM provider — the single production implementation."""

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
    LLMUpstreamError,
)
from agentcore.core.logging import get_logger
from agentcore.llm.errors import (
    body_preview,
    client_error_message,
    diagnose_empty_response,
    is_non_retryable_client_status,
    upstream_client_error,
    upstream_error,
)
from agentcore.llm.observability import log_llm_call
from agentcore.llm.provider.protocol import (
    LLMChunk,
    LLMRequest,
    LLMResponse,
    TokenUsage,
    ToolCall,
    ToolCallDelta,
    ToolCallFunction,
)
from agentcore.llm.sub2api_probe import probe_sub2api_diagnosis_result

logger = get_logger(__name__)

_MAX_RETRIES = 3
_INITIAL_BACKOFF = 2.0
_BACKOFF_MULTIPLIER = 2.0
# Unary completions can run 150s+ for long-form writing; streaming read timeout is
# per-chunk idle, so a generous ceiling avoids false positives on slow generations.
_REQUEST_TIMEOUT = 300.0


def _usage_from(usage_data: dict) -> TokenUsage:
    details = usage_data.get("completion_tokens_details") or {}
    return TokenUsage(
        input_tokens=usage_data.get("prompt_tokens", 0),
        output_tokens=usage_data.get("completion_tokens", 0),
        reasoning_tokens=details.get("reasoning_tokens", 0),
        cache_hit_tokens=usage_data.get("prompt_cache_hit_tokens", 0),
        cache_miss_tokens=usage_data.get("prompt_cache_miss_tokens", 0),
    )


class OpenAICompatibleProvider:
    """OpenAI-compatible ``/chat/completions`` provider."""

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
        finish_reason = choice.get("finish_reason", "stop")
        content = message.get("content") or ""
        raw_body_preview = body_preview(json.dumps(data, ensure_ascii=False))
        empty_diagnosis: str | None = None
        if not content and not tool_calls:
            diagnosis = diagnose_empty_response(
                raw_body=raw_body_preview,
                finish_reason=finish_reason,
            )
            empty_diagnosis = diagnosis.value
            logger.warning(
                "llm.empty_response",
                model=data.get("model", request.model),
                scenario=request.scenario,
                raw_body_preview=raw_body_preview,
                finish_reason=finish_reason,
                usage=usage.as_dict(),
                diagnosis=empty_diagnosis,
            )
        response = LLMResponse(
            content=content,
            reasoning_content=message.get("reasoning_content"),
            tool_calls=tool_calls,
            usage=usage,
            finish_reason=finish_reason,
            model=data.get("model", request.model),
            latency_ms=latency_ms,
            empty_diagnosis=empty_diagnosis,
            empty_raw_preview=raw_body_preview if empty_diagnosis else None,
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
            tool_names=[tc.function.name for tc in response.tool_calls]
            if response.tool_calls
            else None,
        )
        return response

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        payload = self._build_payload(request, stream=True)
        has_content = False
        has_tool_calls = False
        last_lines: list[str] = []
        last_finish_reason: str | None = None
        last_usage: TokenUsage | None = None
        json_parse_failures = 0
        parsed_chunks = 0

        async for line in self._stream_with_retry(payload):
            if len(last_lines) >= 5:
                last_lines.pop(0)
            last_lines.append(line)

            if not line.startswith("data: "):
                continue
            data_str = line[6:]
            if data_str.strip() == "[DONE]":
                break
            try:
                data = json.loads(data_str)
            except json.JSONDecodeError:
                json_parse_failures += 1
                continue
            parsed_chunks += 1
            choices = data.get("choices") or [{}]
            choice = choices[0]
            delta = choice.get("delta", {})
            if delta.get("content"):
                has_content = True
            if delta.get("tool_calls"):
                has_tool_calls = True
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
            if choice.get("finish_reason"):
                last_finish_reason = choice.get("finish_reason")
            usage = _usage_from(data["usage"]) if data.get("usage") else None
            if usage:
                last_usage = usage
            yield LLMChunk(
                delta_content=delta.get("content"),
                delta_reasoning=delta.get("reasoning_content"),
                delta_tool_calls=tc_deltas,
                finish_reason=choice.get("finish_reason"),
                usage=usage,
            )

        if not has_content and not has_tool_calls:
            raw_body_preview = body_preview("\n".join(last_lines))
            format_mismatch = json_parse_failures > 0 and parsed_chunks == 0
            diagnosis = diagnose_empty_response(
                raw_body=raw_body_preview,
                finish_reason=last_finish_reason,
                format_mismatch=format_mismatch,
            )
            logger.warning(
                "llm.empty_response",
                model=request.model,
                scenario=request.scenario,
                raw_body_preview=raw_body_preview,
                finish_reason=last_finish_reason,
                usage=last_usage.as_dict() if last_usage else {},
                diagnosis=diagnosis.value,
                sse_tail=last_lines,
            )
            yield LLMChunk(
                empty_diagnosis=diagnosis.value,
                empty_raw_preview=raw_body_preview,
            )

    def _build_payload(self, request: LLMRequest, *, stream: bool) -> dict:
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
            if msg.reasoning_content is not None:
                m["reasoning_content"] = msg.reasoning_content
            elif msg.role == "assistant" and msg.tool_calls:
                # DeepSeek V4 thinking mode: assistant tool-call turns must echo
                # reasoning_content (empty string when the model omitted it).
                m["reasoning_content"] = ""
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

    async def _attach_sub2api_diagnosis(self, err: LLMUpstreamError) -> LLMUpstreamError:
        from agentcore.config.settings import settings

        status = err.details.get("upstream_status", 0)
        if settings.billing_mode != "platform" or status != 503:
            return err

        probe = await probe_sub2api_diagnosis_result()
        if probe is None:
            return err

        err.message = f"{err.message}\n诊断：{probe.diagnosis}"
        err.details["sub2api_diagnosis"] = probe.diagnosis
        if probe.account_email_masked:
            err.details["sub2api_account"] = probe.account_email_masked
        logger.warning(
            "llm.upstream_error",
            provider=self._name,
            status_code=status,
            sub2api_diagnosis=probe.diagnosis,
            sub2api_account=probe.account_email_masked,
        )
        return err

    def _raise_for_status(
        self,
        status_code: int,
        backoff: float,
        headers,
        *,
        body: bytes | None = None,
        attempt: int = 0,
    ) -> None:
        if status_code == 429:
            retry_after = float(headers.get("retry-after", backoff))
            raise LLMRateLimitError(retry_after=retry_after)
        if status_code in (401, 403):
            raise LLMAuthError()
        if status_code == 402:
            raise LLMInsufficientBalanceError()
        if status_code >= 500:
            logger.warning(
                "llm.upstream_error",
                provider=self._name,
                status_code=status_code,
                attempt=attempt + 1,
            )
            err = upstream_error(
                f"{self._name} 服务端错误（{status_code}），请稍后再试",
                status=status_code,
                body=body,
                retry_attempts=attempt,
            )
            if headers.get("x-upstream-retried"):
                err.retryable = False
            raise err
        if is_non_retryable_client_status(status_code) or 400 <= status_code < 500:
            logger.warning(
                "llm.client_error",
                provider=self._name,
                status_code=status_code,
                body_preview=body_preview(body),
            )
            raise upstream_client_error(
                client_error_message(self._name, status_code, body),
                status=status_code,
                body=body,
            )

    def _network_error_to_llm(self, exc: httpx.HTTPError) -> LLMError:
        """Map transient transport failures to retryable LLM errors."""
        if isinstance(exc, httpx.TimeoutException):
            return LLMTimeoutError(f"连接 {self._name} 超时，请检查网络后重试")
        detail = str(exc).strip() or type(exc).__name__
        return upstream_error(
            f"{self._name} 连接中断，请稍后再试",
            status=502,
            body=detail.encode(),
        )

    def _can_retry_attempt(self, attempt: int) -> bool:
        return attempt < _MAX_RETRIES - 1

    async def _sleep_before_retry(
        self,
        *,
        attempt: int,
        backoff: float,
        stream: bool,
        reason: str,
        partial_sse_lines: int = 0,
    ) -> float:
        wait = backoff
        logger.info(
            "llm.call_retried",
            provider=self._name,
            attempt=attempt + 1,
            max_attempts=_MAX_RETRIES,
            wait_sec=wait,
            stream=stream,
            reason=reason,
            partial_sse_lines=partial_sse_lines or None,
        )
        await asyncio.sleep(wait)
        return backoff * _BACKOFF_MULTIPLIER

    async def _finalize_upstream_error(
        self, err: LLMUpstreamError, attempt: int
    ) -> LLMUpstreamError:
        final = upstream_error(
            err.message,
            status=err.details.get("upstream_status", 500),
            body=err.details.get("upstream_body_preview"),
            retry_attempts=attempt + 1,
        )
        raise await self._attach_sub2api_diagnosis(final) from err

    async def _request_with_retry(self, payload: dict) -> dict:
        last_error: Exception | None = None
        backoff = _INITIAL_BACKOFF
        for attempt in range(_MAX_RETRIES):
            try:
                response = await self._client.post("/chat/completions", json=payload)
                body = response.content if response.status_code >= 400 else None
                self._raise_for_status(
                    response.status_code, backoff, response.headers, body=body, attempt=attempt
                )
                return response.json()
            except LLMUpstreamError as e:
                last_error = e
                if not e.retryable or not self._can_retry_attempt(attempt):
                    await self._finalize_upstream_error(e, attempt)
                backoff = await self._sleep_before_retry(
                    attempt=attempt,
                    backoff=backoff,
                    stream=False,
                    reason=f"upstream_{e.details.get('upstream_status', 500)}",
                )
            except (LLMRateLimitError, LLMError) as e:
                last_error = e
                if not e.retryable or not self._can_retry_attempt(attempt):
                    raise
                retry_after = e.retry_after if isinstance(e, LLMRateLimitError) else None
                wait = retry_after or backoff
                logger.info(
                    "llm.call_retried",
                    provider=self._name,
                    attempt=attempt + 1,
                    max_attempts=_MAX_RETRIES,
                    wait_sec=wait,
                    stream=False,
                    reason=type(e).__name__,
                )
                await asyncio.sleep(wait)
                backoff *= _BACKOFF_MULTIPLIER
            except httpx.TimeoutException as e:
                last_error = LLMTimeoutError(f"连接 {self._name} 超时，请检查网络后重试")
                if not self._can_retry_attempt(attempt):
                    raise last_error from e
                backoff = await self._sleep_before_retry(
                    attempt=attempt,
                    backoff=backoff,
                    stream=False,
                    reason="timeout",
                )
            except httpx.HTTPError as e:
                last_error = self._network_error_to_llm(e)
                if not last_error.retryable or not self._can_retry_attempt(attempt):
                    raise last_error from e
                backoff = await self._sleep_before_retry(
                    attempt=attempt,
                    backoff=backoff,
                    stream=False,
                    reason=type(e).__name__,
                )
        raise last_error or LLMError(f"{self._name} 多次重试后仍失败，请稍后重试")

    async def _stream_with_retry(self, payload: dict) -> AsyncIterator[str]:
        last_error: Exception | None = None
        backoff = _INITIAL_BACKOFF
        for attempt in range(_MAX_RETRIES):
            lines_yielded = 0
            try:
                async with self._client.stream(
                    "POST", "/chat/completions", json=payload
                ) as response:
                    body = await response.aread() if response.status_code >= 400 else None
                    self._raise_for_status(
                        response.status_code,
                        backoff,
                        response.headers,
                        body=body,
                        attempt=attempt,
                    )
                    async for line in response.aiter_lines():
                        lines_yielded += 1
                        yield line
                    return
            except LLMUpstreamError as e:
                last_error = e
                if not e.retryable or not self._can_retry_attempt(attempt) or lines_yielded > 0:
                    if lines_yielded > 0:
                        logger.warning(
                            "llm.stream_partial_disconnect",
                            provider=self._name,
                            partial_sse_lines=lines_yielded,
                            reason=f"upstream_{e.details.get('upstream_status', 500)}",
                        )
                    await self._finalize_upstream_error(e, attempt)
                backoff = await self._sleep_before_retry(
                    attempt=attempt,
                    backoff=backoff,
                    stream=True,
                    reason=f"upstream_{e.details.get('upstream_status', 500)}",
                )
            except (LLMRateLimitError, LLMError) as e:
                last_error = e
                if not e.retryable or not self._can_retry_attempt(attempt) or lines_yielded > 0:
                    raise
                retry_after = e.retry_after if isinstance(e, LLMRateLimitError) else None
                wait = retry_after or backoff
                logger.info(
                    "llm.call_retried",
                    provider=self._name,
                    attempt=attempt + 1,
                    max_attempts=_MAX_RETRIES,
                    wait_sec=wait,
                    stream=True,
                    reason=type(e).__name__,
                )
                await asyncio.sleep(wait)
                backoff *= _BACKOFF_MULTIPLIER
            except httpx.TimeoutException as e:
                last_error = LLMTimeoutError(f"连接 {self._name} 超时，请检查网络后重试")
                if not self._can_retry_attempt(attempt) or lines_yielded > 0:
                    if lines_yielded > 0:
                        logger.warning(
                            "llm.stream_partial_disconnect",
                            provider=self._name,
                            partial_sse_lines=lines_yielded,
                            reason="timeout",
                        )
                    raise last_error from e
                backoff = await self._sleep_before_retry(
                    attempt=attempt,
                    backoff=backoff,
                    stream=True,
                    reason="timeout",
                )
            except httpx.HTTPError as e:
                last_error = self._network_error_to_llm(e)
                if (
                    not last_error.retryable
                    or not self._can_retry_attempt(attempt)
                    or lines_yielded > 0
                ):
                    if lines_yielded > 0:
                        logger.warning(
                            "llm.stream_partial_disconnect",
                            provider=self._name,
                            partial_sse_lines=lines_yielded,
                            reason=type(e).__name__,
                        )
                    raise last_error from e
                backoff = await self._sleep_before_retry(
                    attempt=attempt,
                    backoff=backoff,
                    stream=True,
                    reason=type(e).__name__,
                    partial_sse_lines=lines_yielded,
                )
        raise last_error or LLMError(f"{self._name} 多次重试后仍失败，请稍后重试")

    async def probe(self, *, model: str) -> None:
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

    async def probe_tools(self, *, model: str) -> bool:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "Call the dummy tool."}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "dummy_probe",
                        "description": "Connectivity probe",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
            "max_tokens": 16,
            "stream": False,
        }
        try:
            response = await self._client.post("/chat/completions", json=payload)
        except (httpx.TimeoutException, httpx.HTTPError):
            return False
        if response.status_code >= 300 and response.status_code != 429:
            return False
        try:
            data = response.json()
        except ValueError:
            return False
        choices = data.get("choices") or []
        if not choices:
            return False
        message = choices[0].get("message") or {}
        return bool(message.get("tool_calls"))

    async def close(self) -> None:
        await self._client.aclose()
