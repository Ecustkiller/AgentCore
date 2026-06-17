"""Cloud inference proxy for the on-machine sidecar (双模式工作区 §一.1 / Slice 4a).

A sidecar turn runs the engine on the user's machine, but its LLM calls must NOT
hold the platform key locally, and platform-mode spend must be metered where the
client can't under-report it. This module is that single choke point:

- ``POST /v1/inference/token`` — the desktop (cookie-auth) exchanges its session
  for a short-lived, scoped *inference token* it hands to the local engine. The
  renderer can't read the httpOnly cookie, so this mint is the only way the
  sidecar gets a usable bearer.
- ``POST /v1/inference/v1/chat/completions`` — an OpenAI-shaped passthrough the
  sidecar's ``DeepSeekProvider`` points at (its ``base_url`` = ``…/v1/inference``).
  It authenticates the inference token, runs the SAME spend gate as a cloud turn
  (BYOK key required / platform quota enforced), resolves credentials SERVER-side
  (no key ever reaches the client), forwards to DeepSeek (stream + unary), and
  records the call's real usage into ``cost_events`` — so platform metering is
  authoritative here, not trusted from the client's ``cost_runs`` (those are
  dropped for proxied sidecar turns; see desktop wiring).

Attribution is conversation-grain for v1: each proxied call lands one ledger row
under the ``X-AgentCore-Conversation`` header with ``message_id = NULL`` (same
shape as the off-turn 标题/记忆 background calls), so account/conversation/quota
totals stay honest. Per-message 工资单 splitting is a later refinement.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import (
    AuthUser,
    get_cost_event_repo,
    get_db,
    get_user_repo,
)
from agentcore.config import settings
from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.core.errors import (
    AuthenticationError,
    BYOKKeyMissingError,
    QuotaExceededError,
)
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.models import User
from agentcore.db.repositories import CostEventRepository, UserRepository
from agentcore.llm.byok import (
    INFERENCE_CONVERSATION_HEADER,
    LLMCredentials,
    resolve_user_llm_credentials,
)
from agentcore.llm.protocol import TokenUsage
from agentcore.runtime.costing import ROLE_CAPTAIN, background_run_cost
from agentcore.security import create_inference_token, decode_inference_token

logger = get_logger(__name__)

router = APIRouter(tags=["inference"])

# The engine's ``DeepSeekProvider`` posts to ``{base_url}/v1/chat/completions``, so
# the proxy route sits at ``…/v1/inference`` + this suffix and forwards upstream to
# the same suffix on DeepSeek (api.deepseek.com/v1/chat/completions).
_UPSTREAM_PATH = "/v1/chat/completions"
# Per-turn conversation id the sidecar stamps on each LLM call (shared constant), so
# the proxy can attribute the (NOT NULL) cost_events.conversation_id without trusting
# the body.
_CONVERSATION_HEADER = INFERENCE_CONVERSATION_HEADER
# Match the provider's own budget (llm/deepseek.py) so a legit long call isn't cut.
_REQUEST_TIMEOUT = 120.0


class InferenceTokenResponse(BaseModel):
    """A freshly minted inference token + its lifetime (the desktop re-mints on
    expiry when (re)initializing the sidecar)."""

    token: str
    expires_in_sec: int


@router.post("/inference/token", response_model=InferenceTokenResponse)
async def mint_inference_token(user: AuthUser) -> InferenceTokenResponse:
    """Exchange the caller's cookie session for a scoped inference token (Slice 4a).

    Cookie-authenticated like the rest of the API; returns a token the desktop
    passes to its local sidecar so the engine's LLM calls reach ``/v1/inference``
    as this user (the platform key stays server-side).
    """
    return InferenceTokenResponse(
        token=create_inference_token(user.user_id),
        expires_in_sec=settings.inference_token_expire_minutes * 60,
    )


async def inference_user(
    authorization: Annotated[str | None, Header()] = None,
    user_repo: UserRepository = Depends(get_user_repo),
) -> User:
    """Resolve the user from the ``Authorization: Bearer <inference-token>`` header.

    The sidecar's provider sends the token as a bearer (it has no cookie jar), so
    this is the proxy's auth — distinct from the cookie dependency. A regular
    access token is refused by ``decode_inference_token`` (wrong type) → 401.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AuthenticationError("Missing inference token")
    user_id = decode_inference_token(authorization.split(" ", 1)[1].strip())
    user = await user_repo.get_by_id(user_id)
    if user is None or user.status != "active":
        raise AuthenticationError("User not found or inactive")
    return user


async def _resolve_inference_credentials(
    session: AsyncSession,
    cost_repo: CostEventRepository,
    user: User,
) -> LLMCredentials:
    """Resolve the upstream credentials and run the spend gate (mirrors the cloud
    turn's ``_preflight_turn_llm``): BYOK mode requires the user's own key; platform
    mode enforces quota and forwards on the global key. Either way the key is
    resolved here and never leaves the server.
    """
    if settings.billing_mode == "byok":
        credentials = await resolve_user_llm_credentials(session, user.user_id)
        if credentials is None:
            raise BYOKKeyMissingError(
                "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再发起对话。"
            )
        return credentials
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))
    return LLMCredentials(
        api_key=settings.deepseek_api_key, base_url=settings.deepseek_base_url
    )


def _usage_from_deepseek(usage: dict) -> TokenUsage:
    """Map a DeepSeek ``usage`` block to the engine's ``TokenUsage`` (same field
    reading as ``DeepSeekProvider``, so pricing stays identical)."""
    details = usage.get("completion_tokens_details") or {}
    return TokenUsage(
        input_tokens=int(usage.get("prompt_tokens", 0) or 0),
        output_tokens=int(usage.get("completion_tokens", 0) or 0),
        reasoning_tokens=int(details.get("reasoning_tokens", 0) or 0),
        cache_hit_tokens=int(usage.get("prompt_cache_hit_tokens", 0) or 0),
        cache_miss_tokens=int(usage.get("prompt_cache_miss_tokens", 0) or 0),
    )


async def _record_proxy_spend(
    *, user_id: str, conversation_id: str | None, model: str, usage: TokenUsage
) -> None:
    """Authoritatively land one proxied LLM call's spend in ``cost_events`` (计费权威).

    Priced server-side off the real upstream usage via the one ``calculate_cost``
    (``background_run_cost``), under a fresh ``run_id`` with ``message_id = NULL`` —
    so it SUMs into account/conversation/quota totals exactly like the cloud's
    off-turn background calls. Uses its OWN session (not the request's) because for a
    streamed turn this fires from the response generator's teardown, after the
    request session is gone. Best-effort: a ledger failure must never break a turn
    whose answer already streamed (文档铁律).
    """
    if not conversation_id:
        # The sidecar always stamps the header; its absence means a misconfigured
        # caller. Forward still succeeded — skip the ledger rather than crash.
        logger.warning(
            "inference.proxy_spend_no_conversation", user_id=user_id, model=model
        )
        return
    run = background_run_cost(ROLE_CAPTAIN, model or "", usage)
    try:
        async with async_session_factory() as session:
            await CostEventRepository(session).record_runs(
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
    """OpenAI-shaped LLM proxy for the on-machine sidecar (Slice 4a).

    Gate (spend) → resolve credentials server-side → forward to DeepSeek → record
    real usage. A spend block maps to HTTP 402 — the provider's only non-retryable
    "can't spend" status — so the turn fails cleanly instead of the provider
    retrying a 429 three times. Upstream status codes pass through verbatim so the
    sidecar's provider keeps its 401/402/429/5xx handling.
    """
    payload = await request.json()
    stream = bool(payload.get("stream"))
    conversation_id = request.headers.get(_CONVERSATION_HEADER) or None

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
            client, payload, user_id=user.user_id, conversation_id=conversation_id
        )
    return await _forward_unary(
        client, payload, user_id=user.user_id, conversation_id=conversation_id
    )


async def _forward_unary(
    client: httpx.AsyncClient,
    payload: dict,
    *,
    user_id: str,
    conversation_id: str | None,
) -> Response:
    """Forward a non-streaming completion; record spend on a 200, pass status through."""
    try:
        upstream = await client.post(_UPSTREAM_PATH, json=payload)
        body, status = upstream.content, upstream.status_code
    except httpx.HTTPError as e:
        logger.warning("inference.proxy_upstream_error", error=str(e))
        return JSONResponse(
            status_code=502,
            content={"error": {"code": "LLM_ERROR", "message": "上游推理服务不可达"}},
        )
    finally:
        await client.aclose()

    if status == 200:
        try:
            data = json.loads(body)
            await _record_proxy_spend(
                user_id=user_id,
                conversation_id=conversation_id,
                model=data.get("model") or payload.get("model") or "",
                usage=_usage_from_deepseek(data.get("usage") or {}),
            )
        except Exception as e:  # recording must never turn a good answer into an error
            logger.warning("inference.proxy_unary_record_failed", error=str(e))
    return Response(content=body, status_code=status, media_type="application/json")


async def _forward_stream(
    client: httpx.AsyncClient,
    payload: dict,
    *,
    user_id: str,
    conversation_id: str | None,
) -> Response:
    """Forward a streaming completion line-by-line, teeing the final usage chunk to
    record spend once the stream ends."""
    cm = client.stream("POST", _UPSTREAM_PATH, json=payload)
    try:
        upstream = await cm.__aenter__()
    except httpx.HTTPError as e:
        await client.aclose()
        logger.warning("inference.proxy_upstream_error", error=str(e))
        return JSONResponse(
            status_code=502,
            content={"error": {"code": "LLM_ERROR", "message": "上游推理服务不可达"}},
        )

    # A non-200 carries no event stream — drain it and pass the status through so the
    # provider maps 401/402/429/5xx the same as a direct DeepSeek call.
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
                # Re-add the newline aiter_lines stripped; the consumer (our provider)
                # re-splits on it, so SSE framing round-trips.
                yield f"{line}\n"
        finally:
            await cm.__aexit__(None, None, None)
            await client.aclose()
            usage = captured.get("usage")
            if usage:
                await _record_proxy_spend(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    model=captured.get("model") or payload.get("model") or "",
                    usage=_usage_from_deepseek(usage),
                )

    return StreamingResponse(relay(), media_type="text/event-stream")
