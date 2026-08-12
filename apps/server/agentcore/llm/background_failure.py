"""Classify side-path LLM failures for observability (title / memory / compaction).

Buckets are product-chrome oriented: auth vs upstream blip vs timeout vs
invalid_response (2xx non-JSON) vs other.
Quota skips stay on ``billing.background_quota_skip`` — callers pass
``reason=quota_skip`` only when they already know the gate returned None after quota.

``is_config_shaped_background_failure`` drives BYOK provider ``status=error``
marking in ``billing.gate`` (llm must not import db).
"""

from __future__ import annotations

from typing import Literal

from agentcore.core.errors import (
    InferenceTokenExpiredError,
    LLMAuthError,
    LLMError,
    LLMInvalidResponseError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUpstreamError,
)

BackgroundFailureReason = Literal[
    "auth",
    "upstream_unstable",
    "timeout",
    "quota_skip",
    "provider_unavailable",
    "invalid_response",
    "rate_limit",
    "other",
]


def classify_background_llm_failure(exc: BaseException) -> BackgroundFailureReason:
    """Map an exception to a stable ``reason`` for side-path failure logs / SSE."""
    if isinstance(exc, LLMAuthError):
        return "auth"
    if isinstance(exc, LLMRateLimitError):
        return "rate_limit"
    if isinstance(exc, TimeoutError | LLMTimeoutError):
        return "timeout"
    if isinstance(exc, LLMInvalidResponseError):
        return "invalid_response"
    if isinstance(exc, LLMUpstreamError):
        status = _upstream_status(exc)
        if status is None or status >= 500:
            return "upstream_unstable"
        return "other"
    msg = str(exc).casefold()
    if "background credentials unavailable" in msg:
        return "provider_unavailable"
    if "quota" in msg or "free tier" in msg or "额度" in msg:
        return "quota_skip"
    return "other"


def is_config_shaped_background_failure(exc: BaseException) -> bool:
    """True when a side-path failure indicates broken BYOK provider *config*.

    Allowlist (non-retryable + config-shaped only):
    - ``LLMAuthError`` (bad / revoked key) — not inference JWT remint
    - ``LLMInvalidResponseError`` (2xx non-JSON shell)
    - ``LLMError`` with ``upstream_status == 404`` (model missing / bad base_url)

    Explicitly *not* config: timeout / 5xx / rate-limit / network jitter,
    balance exhaustion, closed-client races, context overflow, etc.
    """
    if isinstance(exc, InferenceTokenExpiredError):
        return False
    if isinstance(exc, LLMAuthError):
        return True
    if isinstance(exc, LLMInvalidResponseError):
        return True
    if isinstance(exc, LLMError) and not exc.retryable:
        status = _llm_upstream_status(exc)
        if status == 404:
            return True
    return False


def _llm_upstream_status(exc: LLMError) -> int | None:
    details = getattr(exc, "details", None) or {}
    if not isinstance(details, dict):
        return None
    for key in ("upstream_status", "status", "status_code", "http_status"):
        raw = details.get(key)
        if isinstance(raw, int):
            return raw
        if isinstance(raw, str) and raw.isdigit():
            return int(raw)
    return None


def _upstream_status(exc: LLMUpstreamError) -> int | None:
    return _llm_upstream_status(exc)
