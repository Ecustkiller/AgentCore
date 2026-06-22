"""OpenAI-shaped LLM proxy for on-machine sidecar turns."""

from __future__ import annotations

import json
from dataclasses import asdict

import httpx
from fastapi import Depends, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import get_cost_event_repo, get_db
from agentcore.api.routes.inference.token import inference_user, router
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import BYOKKeyMissingError, QuotaExceededError
from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.db.models import User
from agentcore.db.repositories import CostEventRepository
from agentcore.llm.byok import (
    INFERENCE_CONVERSATION_HEADER,
    INFERENCE_TRACE_HEADER,
    LLMCredentials,
)
from agentcore.llm.protocol import TokenUsage

logger = get_logger(__name__)

_UPSTREAM_PATH = "/v1/chat/completions"
_CONVERSATION_HEADER = INFERENCE_CONVERSATION_HEADER
_TRACE_HEADER = INFERENCE_TRACE_HEADER
_REQUEST_TIMEOUT = 120.0


async def _resolve_inference_credentials(
    session: AsyncSession,
    cost_repo: CostEventRepository,
    user: User,
) -> LLMCredentials:
    from agentcore.api.routes import inference as inf

    if inf.settings.billing_mode == "byok":
        credentials = await inf.resolve_user_llm_credentials(session, user.user_id)
        if credentials is None:
            raise BYOKKeyMissingError(
                "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再发起对话。"
            )
        return credentials
    await inf.enforce_quota(cost_repo, user.user_id, limits=inf.QuotaLimits.for_user(user))
    return LLMCredentials(
        api_key=inf.settings.deepseek_api_key, base_url=inf.settings.deepseek_base_url
    )


def _usage_from_deepseek(usage: dict) -> TokenUsage:
    details = usage.get("completion_tokens_details") or {}
    return TokenUsage(
        input_tokens=int(usage.get("prompt_tokens", 0) or 0),
        output_tokens=int(usage.get("completion_tokens", 0) or 0),
        reasoning_tokens=int(details.get("reasoning_tokens", 0) or 0),
        cache_hit_tokens=int(usage.get("prompt_cache_hit_tokens", 0) or 0),
        cache_miss_tokens=int(usage.get("prompt_cache_miss_tokens", 0) or 0),
    )


async def _record_proxy_spend(
    *,
    user_id: str,
    conversation_id: str | None,
    model: str,
    usage: TokenUsage,
    trace_id: str | None = None,
) -> None:
    from agentcore.api.routes import inference as inf

    with log_context(trace_id=trace_id, conversation_id=conversation_id):
        if not conversation_id:
            logger.warning("inference.proxy_spend_no_conversation", user_id=user_id, model=model)
            return
        run = inf.background_run_cost(inf.ROLE_CAPTAIN, model or "", usage)
        try:
            async with inf.async_session_factory() as session:
                await inf.CostEventRepository(session).record_runs(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=None,
                    runs=[asdict(run)],
                )
        except Exception as e:
            logger.warning(
                "inference.proxy_spend_failed",
                user_id=user_id,
                conversation_id=conversation_id,
                error=str(e),
            )


@router.post("/inference/v1/chat/completions")
async def inference_chat_completions(
    request: Request,
    user: User = Depends(inference_user),
    session: AsyncSession = Depends(get_db),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
) -> Response:
    payload = await request.json()
    stream = bool(payload.get("stream"))
    conversation_id = request.headers.get(_CONVERSATION_HEADER) or None
    trace_id = request.headers.get(_TRACE_HEADER) or None

    with log_context(trace_id=trace_id, conversation_id=conversation_id, user_id=user.user_id):
        try:
            credentials = await _resolve_inference_credentials(session, cost_repo, user)
        except (QuotaExceededError, BYOKKeyMissingError) as e:
            return JSONResponse(
                status_code=402, content={"error": {"code": e.code, "message": e.message}}
            )

        client = httpx.AsyncClient(
            base_url=credentials.base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {credentials.api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(_REQUEST_TIMEOUT, connect=10.0),
        )

        if stream:
            return await _forward_stream(
                client,
                payload,
                user_id=user.user_id,
                conversation_id=conversation_id,
                trace_id=trace_id,
            )
        return await _forward_unary(
            client,
            payload,
            user_id=user.user_id,
            conversation_id=conversation_id,
            trace_id=trace_id,
        )


async def _forward_unary(
    client: httpx.AsyncClient,
    payload: dict,
    *,
    user_id: str,
    conversation_id: str | None,
    trace_id: str | None = None,
) -> Response:
    try:
        upstream = await client.post(_UPSTREAM_PATH, json=payload)
        body, status = upstream.content, upstream.status_code
    except httpx.HTTPError as e:
        logger.warning("inference.proxy_upstream_error", error=str(e))
        return JSONResponse(
            status_code=502,
            content={"error": {"code": ErrorCode.LLM_ERROR, "message": "上游推理服务不可达"}},
        )
    finally:
        await client.aclose()

    if status == 200:
        try:
            from agentcore.api.routes import inference as inf

            data = json.loads(body)
            await inf._record_proxy_spend(
                user_id=user_id,
                conversation_id=conversation_id,
                model=data.get("model") or payload.get("model") or "",
                usage=inf._usage_from_deepseek(data.get("usage") or {}),
                trace_id=trace_id,
            )
        except Exception as e:
            logger.warning("inference.proxy_unary_record_failed", error=str(e))
    return Response(content=body, status_code=status, media_type="application/json")


async def _forward_stream(
    client: httpx.AsyncClient,
    payload: dict,
    *,
    user_id: str,
    conversation_id: str | None,
    trace_id: str | None = None,
) -> Response:
    cm = client.stream("POST", _UPSTREAM_PATH, json=payload)
    try:
        upstream = await cm.__aenter__()
    except httpx.HTTPError as e:
        await client.aclose()
        logger.warning("inference.proxy_upstream_error", error=str(e))
        return JSONResponse(
            status_code=502,
            content={"error": {"code": ErrorCode.LLM_ERROR, "message": "上游推理服务不可达"}},
        )

    if upstream.status_code != 200:
        body = await upstream.aread()
        await cm.__aexit__(None, None, None)
        await client.aclose()
        return Response(
            content=body,
            status_code=upstream.status_code,
            media_type="application/json",
        )

    captured: dict = {}

    async def relay():
        try:
            async for line in upstream.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:].strip()
                    if chunk and chunk != "[DONE]":
                        try:
                            obj = json.loads(chunk)
                            if obj.get("usage"):
                                captured["usage"] = obj["usage"]
                                captured["model"] = obj.get("model")
                        except json.JSONDecodeError:
                            pass
                yield f"{line}\n"
        finally:
            await cm.__aexit__(None, None, None)
            await client.aclose()
            usage = captured.get("usage")
            if usage:
                from agentcore.api.routes import inference as inf

                await inf._record_proxy_spend(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    model=captured.get("model") or payload.get("model") or "",
                    usage=inf._usage_from_deepseek(usage),
                    trace_id=trace_id,
                )

    return StreamingResponse(relay(), media_type="text/event-stream")
