"""Read side-path LLM failures (title / memory / compaction) — bucket and date them.

Two questions, both asked about a failure nobody will ever see on screen:

- *what kind of failure was it* — :func:`classify_background_llm_failure` buckets it
  product-chrome style (auth vs upstream blip vs timeout vs invalid_response vs
  other) for logs and SSE. Quota skips stay on ``billing.background_quota_skip`` —
  callers pass ``reason=quota_skip`` only when they already know the gate skipped
  after quota.
- *when does retrying stop being pointless* — :func:`declared_recovery_seconds`
  answers only when upstream itself said so, and ``None`` otherwise.

``is_config_shaped_background_failure`` drives BYOK provider ``status=error``
marking in ``billing.gate`` (llm must not import db).
"""

from __future__ import annotations

import math
from typing import Literal

from agentcore.core.errors import (
    RETRY_AFTER_FROM_HEADER,
    RETRY_AFTER_UNKNOWN,
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


def declared_recovery_seconds(exc: BaseException) -> float | None:
    """How long the failure says a retry stays pointless — ``None`` if it does not say.

    Two independent conditions, and neither may stand in for the other. The number
    has to be upstream's own (``retry_after_source``), and the call has to have given
    up on it rather than slept it off (``retryable`` false): only then is
    「此刻之前重试必然失败」something upstream stated, rather than something we
    inferred from a streak — or from our own arithmetic.

    Provenance is **read, never derived**. A header-less 429 carries a
    ``retry_after`` too: the last link of our own 2→4→8→16→32 backoff, which outgrows
    a background call's budget and therefore arrives here non-retryable *and* dated —
    the exact shape this used to accept as「上游指明了额度何时恢复」. It proves no
    such thing (see :data:`~agentcore.core.errors.RETRY_AFTER_FROM_HEADER`), and one
    of those 32-second numbers was enough to make compaction skip a whole fold pass.
    Every unknown-duration failure (timeout, empty output, parse error) stays silent
    here as before, as does a cooldown relayed across our ``/inference/`` hop, which
    arrives as a bare number no side of that hop can attest.

    The date is read from the attribute *or* from ``details``: a platform-funded 429
    past the call's budget takes the ``LLMQuotaExceededError`` face
    (``upstream_rate_limit_error``), which keeps its ``Retry-After`` in ``details``
    only — its provenance rides on the attribute, like the 429 face's. That face is
    the common one on this path, so reading just the attribute would answer ``None``
    for exactly the failures worth dating.
    """
    if getattr(exc, "retry_after_source", RETRY_AFTER_UNKNOWN) != RETRY_AFTER_FROM_HEADER:
        return None
    if getattr(exc, "retryable", True):
        return None
    seconds = getattr(exc, "retry_after", None)
    if seconds is None:
        details = getattr(exc, "details", None)
        if isinstance(details, dict):
            seconds = details.get("retry_after")
    if not isinstance(seconds, int | float):
        return None
    return float(seconds) if 0 < seconds < math.inf else None


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
