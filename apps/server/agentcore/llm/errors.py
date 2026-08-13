"""LLM error context helpers — unified upstream diagnostics."""

from __future__ import annotations

import contextlib
import json
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import (
    AgentCoreError,
    InferenceTokenExpiredError,
    LLMAuthError,
    LLMError,
    LLMInsufficientBalanceError,
    LLMKeyRequiredError,
    LLMQuotaExceededError,
    LLMRateLimitError,
    LLMUpstreamError,
    OurServiceUnavailableError,
    upstream_rate_limit_error,
)

# Keep in sync with ``db.errors.DATABASE_UNAVAILABLE_MESSAGE`` — do not import
# ``db.errors`` here (llm → db → repositories → llm.profiles cycle).
_OUR_SERVICE_UNAVAILABLE_MESSAGE = "AgentCore 服务暂时不可用，请稍后重试"

# Our-cloud faults a retry cannot clear (server misconfiguration, not pressure).
_OUR_SERVICE_PERMANENT_CODES = frozenset(
    {ErrorCode.KEY_STORAGE_UNAVAILABLE, ErrorCode.PLATFORM_BILLING_UNAVAILABLE}
)

_BODY_PREVIEW_MAX = 500


class EmptyResponseDiagnosis(StrEnum):
    # Upstream returned HTML / login / gateway page instead of a chat completion.
    # (Formerly oauth_expired — that name falsely implied Sub2API OAuth expiry.)
    UPSTREAM_NON_API = "upstream_non_api"
    CONTENT_FILTERED = "content_filtered"
    MODEL_UNKNOWN = "model_unknown"
    SILENT_EMPTY = "silent_empty"
    FORMAT_MISMATCH = "format_mismatch"
    # Upstream finish_reason=length with empty body + no tools (protocol-proven).
    LENGTH_EMPTY = "length_empty"


# HTML shell or auth/login phrasing — not a model completion body.
_NON_API_MARKERS = re.compile(
    r"(<html|</html>|<!doctype|oauth|sign[\s_-]?in|login|unauthorized|access[\s_-]?denied)",
    re.IGNORECASE,
)
_MODEL_UNKNOWN_MARKERS = re.compile(
    r"(model[\s_-]?(not[\s_-]?found|does[\s_-]?not[\s_-]?exist|unknown|invalid)|"
    r"unknown[\s_-]?model|invalid[\s_-]?model)",
    re.IGNORECASE,
)

_DIAGNOSIS_LABELS: dict[EmptyResponseDiagnosis, str] = {
    EmptyResponseDiagnosis.UPSTREAM_NON_API: (
        "上游返回了网页或登录页，请检查服务商地址与鉴权"
    ),
    EmptyResponseDiagnosis.CONTENT_FILTERED: "内容被过滤",
    EmptyResponseDiagnosis.MODEL_UNKNOWN: "模型名未被上游识别",
    EmptyResponseDiagnosis.SILENT_EMPTY: "模型返回空内容",
    EmptyResponseDiagnosis.FORMAT_MISMATCH: "上游响应格式异常",
    EmptyResponseDiagnosis.LENGTH_EMPTY: "输出长度截断 · 返回空内容",
}


def diagnose_empty_response(
    *,
    raw_body: str | None,
    finish_reason: str | None = None,
    format_mismatch: bool = False,
) -> EmptyResponseDiagnosis:
    """Classify an empty LLM response from upstream body / finish_reason."""
    if format_mismatch:
        return EmptyResponseDiagnosis.FORMAT_MISMATCH
    if finish_reason == "content_filter":
        return EmptyResponseDiagnosis.CONTENT_FILTERED
    # Protocol field only — no reasoning-length / token-cap heuristics.
    if finish_reason == "length":
        return EmptyResponseDiagnosis.LENGTH_EMPTY
    text = (raw_body or "").strip()
    if text and _NON_API_MARKERS.search(text):
        return EmptyResponseDiagnosis.UPSTREAM_NON_API
    if text and _MODEL_UNKNOWN_MARKERS.search(text):
        return EmptyResponseDiagnosis.MODEL_UNKNOWN
    if text:
        try:
            data = json.loads(text)
            if isinstance(data, dict) and data.get("error"):
                err = data["error"]
                err_text = err if isinstance(err, str) else json.dumps(err, ensure_ascii=False)
                if _NON_API_MARKERS.search(err_text):
                    return EmptyResponseDiagnosis.UPSTREAM_NON_API
                if _MODEL_UNKNOWN_MARKERS.search(err_text):
                    return EmptyResponseDiagnosis.MODEL_UNKNOWN
        except json.JSONDecodeError:
            if "<" in text and ">" in text:
                return EmptyResponseDiagnosis.UPSTREAM_NON_API
            # A non-JSON ``text`` here is the streaming SSE tail (several ``data:``
            # lines), NOT a real format error — the genuine "couldn't parse any
            # chunk" case is signalled up front by the explicit ``format_mismatch``
            # flag. Fall through to SILENT_EMPTY so a clean tool_calls/stop finish
            # with empty deltas reads as "模型返回空内容" instead of the misleading
            # "上游响应格式异常".
    return EmptyResponseDiagnosis.SILENT_EMPTY


def _coerce_diagnosis(
    diagnosis: str | EmptyResponseDiagnosis | None,
) -> EmptyResponseDiagnosis | None:
    """Normalize wire/journal diagnosis keys (incl. legacy oauth_expired)."""
    if diagnosis is None:
        return None
    if isinstance(diagnosis, EmptyResponseDiagnosis):
        return diagnosis
    if diagnosis == "oauth_expired":
        return EmptyResponseDiagnosis.UPSTREAM_NON_API
    try:
        return EmptyResponseDiagnosis(diagnosis)
    except ValueError:
        return None


def empty_response_body_kind(raw_body: str | None) -> str:
    """Coarse body class for SSE error context / 排查包 (not the raw HTML)."""
    text = (raw_body or "").strip()
    if not text:
        return "empty"
    lowered = text[:2000].lower()
    if "<html" in lowered or "<!doctype" in lowered or '<div id="root"' in lowered:
        return "html"
    if text[0] in "{[":
        try:
            json.loads(text)
            return "json"
        except json.JSONDecodeError:
            return "text"
    return "text"


def empty_response_error_context(
    *,
    diagnosis: str | EmptyResponseDiagnosis | None,
    raw_preview: str | None = None,
    base_url: str | None = None,
) -> dict[str, str] | None:
    """SSE ``error.context`` for empty-response degraded (no raw HTML leak)."""
    ctx: dict[str, str] = {}
    key = _coerce_diagnosis(diagnosis)
    if key is not None:
        ctx["empty_diagnosis"] = key.value
    elif diagnosis is not None:
        ctx["empty_diagnosis"] = str(diagnosis)
    kind = empty_response_body_kind(raw_preview)
    if kind != "empty" or raw_preview is not None:
        ctx["body_kind"] = kind
    if base_url:
        ctx["base_url"] = base_url.rstrip("/")
    return ctx or None


def empty_response_event_message(diagnosis: str | EmptyResponseDiagnosis | None) -> str:
    """User-facing SSE error message for a degraded empty-response finish.

    ``length_empty`` is a first-round hard cutoff (not a streak), so its copy
    must not say「多次空响应」— that wording is reserved for the silent-empty ladder.
    """
    key = _coerce_diagnosis(diagnosis)
    if key is not None:
        if key is EmptyResponseDiagnosis.LENGTH_EMPTY:
            return f"模型空响应 · {_DIAGNOSIS_LABELS[key]}"
        label = _DIAGNOSIS_LABELS.get(key)
        base = "模型多次空响应"
        return f"{base} · {label}" if label else base
    if diagnosis is not None:
        return f"模型多次空响应 · {diagnosis}"
    return "模型多次空响应"


def empty_response_chip_label(diagnosis: str | EmptyResponseDiagnosis | None) -> str | None:
    """Short label for the degraded finish-reason chip (diagnosis only)."""
    if diagnosis is None:
        return None
    key = _coerce_diagnosis(diagnosis)
    if key is not None:
        return _DIAGNOSIS_LABELS.get(key)
    return str(diagnosis)


@dataclass(frozen=True)
class LLMErrorContext:
    upstream_status: int
    upstream_body_preview: str | None
    retry_attempts: int


def body_preview(raw: bytes | str | None) -> str | None:
    if raw is None:
        return None
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    text = text.strip()
    if not text:
        return None
    if len(text) > _BODY_PREVIEW_MAX:
        return text[:_BODY_PREVIEW_MAX] + "…"
    return text


def _extract_upstream_message(preview: str | None) -> str | None:
    if not preview:
        return None
    try:
        data = json.loads(preview)
    except json.JSONDecodeError:
        return preview if len(preview) <= 200 else preview[:200] + "…"
    if not isinstance(data, dict):
        return None
    err = data.get("error")
    if isinstance(err, dict):
        msg = err.get("message")
        if msg:
            return str(msg)
    if isinstance(err, str):
        return err
    msg = data.get("message")
    return str(msg) if msg else None


def _extract_upstream_code(preview: str | None) -> str | None:
    if not preview:
        return None
    try:
        data = json.loads(preview)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    err = data.get("error")
    if isinstance(err, dict):
        code = err.get("code")
        return str(code) if code else None
    return None


@dataclass(frozen=True)
class AgentCoreErrorEnvelope:
    """Our wire envelope ``{"error":{"code","message","context"}}`` (catalogued code only)."""

    code: str
    message: str | None
    context: dict | None = None


def parse_agentcore_error_envelope(
    body: bytes | str | None,
) -> AgentCoreErrorEnvelope | None:
    """Parse our structured error envelope; None if shape/code is not ours.

    Only trusts ``{"error":{"code": <ErrorCode>, "message": ...}}``. Does not
    sniff free text or vendor gateway tutorials (CC Switch, etc.).
    """
    preview = body_preview(body)
    if not preview:
        return None
    try:
        data = json.loads(preview)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    err = data.get("error")
    if not isinstance(err, dict):
        return None
    raw_code = err.get("code")
    if not isinstance(raw_code, str) or not raw_code.strip():
        return None
    try:
        catalogued = ErrorCode(raw_code.strip())
    except ValueError:
        return None
    raw_msg = err.get("message")
    message = str(raw_msg).strip() if raw_msg is not None else None
    if message == "":
        message = None
    raw_ctx = err.get("context")
    context = raw_ctx if isinstance(raw_ctx, dict) else None
    return AgentCoreErrorEnvelope(code=catalogued.value, message=message, context=context)


def is_llm_family_error_code(code: str) -> bool:
    """True when the catalogued code is the LLM_* upstream-family prefix."""
    return code.startswith("LLM_")


class _EnvelopeLeafError(Protocol):
    """Constructor shape every leaf in the table below has to offer.

    ``message`` is optional because the envelope's is: a wire error whose
    ``message`` is missing, null or blank parses to ``None`` (see
    :func:`parse_agentcore_error_envelope`). Each leaf answers that with its own
    default copy — the CTA the client routes on — so the table may only hold
    classes that accept ``None`` rather than blanking the message.
    """

    def __call__(self, message: str | None = None, **details: Any) -> LLMError: ...


# Envelope code → the leaf error it stands for. Only codes a client *branches* on
# live here (key-config CTA, retry affordance, JWT remint): those are the ones a
# flattened code silently mistranslates. Everything else keeps falling through to
# the vendor-status heuristics, so this table never grows a case per HTTP status.
# ``LLM_RATE_LIMIT`` is built separately — its copy derives from ``retry_after``,
# not from the envelope message.
_ENVELOPE_LEAF_ERRORS: dict[str, _EnvelopeLeafError] = {
    ErrorCode.QUOTA_EXCEEDED: LLMQuotaExceededError,
    ErrorCode.LLM_KEY_REQUIRED: LLMKeyRequiredError,
    ErrorCode.LLM_KEY_INVALID: LLMAuthError,
    ErrorCode.LLM_INSUFFICIENT_BALANCE: LLMInsufficientBalanceError,
    ErrorCode.INFERENCE_TOKEN_EXPIRED: InferenceTokenExpiredError,
}


def _envelope_retry_after(context: dict) -> float | None:
    raw = context.get("retry_after")
    if raw is None:
        return None
    with contextlib.suppress(TypeError, ValueError):
        return float(raw)
    return None


def inference_envelope_error(
    *,
    status: int,
    body: bytes | str | None,
) -> LLMError | None:
    """Rebuild the typed error our ``/inference/`` hop already classified.

    On that hop the envelope — not the HTTP status — is the truth source. The proxy
    flattens every typed error onto 402 / 429 / 502, and it reports faults no vendor
    status can express (an exhausted allowance, a missing BYOK key), so classifying
    the response by its number reads quota exhaustion as vendor throttling and a
    missing key as an empty wallet. The cloud leaf also phrased the copy with the
    real provider label, so its ``message`` beats anything we could compose here.

    Returns ``None`` when the body is not our envelope, or carries a code no client
    branches on — the caller then falls back to the vendor-status heuristics, which
    stay the only source of truth on a direct-to-vendor hop.
    """
    envelope = parse_agentcore_error_envelope(body)
    if envelope is None:
        return None
    context = envelope.context or {}
    # Prefer the vendor status / body the cloud leaf recorded: ours is only the
    # relay's number (same reason its ``message`` names the vendor's real status).
    upstream_status = context.get("upstream_status")
    if not isinstance(upstream_status, int):
        upstream_status = status
    preview = context.get("upstream_body_preview")
    if not isinstance(preview, str) or not preview.strip():
        preview = body_preview(body)
    details: dict[str, Any] = {
        "upstream_status": upstream_status,
        "upstream_body_preview": preview,
    }
    # Keeps the platform-vs-BYOK CTA split intact across the hop (平台LLM接入 §二).
    raw_source = context.get("credential_source")
    source: str | None = raw_source if raw_source in ("user", "platform") else None

    if envelope.code == ErrorCode.LLM_RATE_LIMIT:
        return upstream_rate_limit_error(
            _envelope_retry_after(context),
            credential_source=source,
            **details,
        )
    leaf = _ENVELOPE_LEAF_ERRORS.get(envelope.code)
    if leaf is None:
        return None
    if source is not None:
        details["credential_source"] = source
    return leaf(envelope.message, **details)


def our_inference_service_5xx_error(
    *,
    status: int,
    body: bytes | str | None,
) -> OurServiceUnavailableError | None:
    """Map a 5xx from our ``/inference/`` hop to a coded our-side error.

    Returns ``None`` when the body is our envelope with an LLM_* code — that
    means the problem is truly upstream and the caller should keep upstream
    semantics. Any other 5xx on this hop (pool exhaustion, internal fault,
    missing catalog envelope, …) is our cloud, not the vendor.
    """
    envelope = parse_agentcore_error_envelope(body)
    if envelope is not None and is_llm_family_error_code(envelope.code):
        return None

    # No envelope (bare gateway page, reverse-proxy 502/503) stays INTERNAL_ERROR:
    # naming a specific fault we cannot prove would poison the very logs used to
    # tell our own outages apart from the vendor's.
    err = OurServiceUnavailableError(
        (envelope.message if envelope else None) or _OUR_SERVICE_UNAVAILABLE_MESSAGE,
        upstream_status=status,
        upstream_body_preview=body_preview(body),
    )
    if envelope is not None:
        err.code = envelope.code
        err.retryable = envelope.code not in _OUR_SERVICE_PERMANENT_CODES
    err.status_code = status if status >= 500 else 503
    return err


def _extract_upstream_error_type(preview: str | None) -> str | None:
    """Anthropic-style ``error.type`` — Zen carries its error class here, not ``code``."""
    if not preview:
        return None
    try:
        data = json.loads(preview)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    err = data.get("error")
    if isinstance(err, dict):
        kind = err.get("type")
        return str(kind) if kind else None
    return None


_AUTH_BODY_CODES = frozenset(
    {
        "key_expired",
        "invalid_api_key",
        "authentication_error",
        "invalid_api_token",
        "account_deactivated",
    }
)
_AUTH_BODY_MARKERS = re.compile(
    r"(api[\s_-]?key|access[\s_-]?token|unauthorized|authentication|"
    r"key[\s_-]?expired|expired|鉴权|无效.*key|key.*无效)",
    re.IGNORECASE,
)
# Balance exhaustion answered with 401/403 instead of the conventional 402
# (OpenCode Zen: ``{"error":{"type":"CreditsError","message":"Insufficient balance…"}}``).
# Body-proven only — a bare 401 with no balance marker stays an auth failure.
_BALANCE_BODY_CODES = frozenset(
    {
        "insufficient_balance",
        "insufficient_credits",
        "creditserror",
        "credits_error",
    }
)
_BALANCE_MARKERS = re.compile(
    r"(insufficient\s+(balance|credits)|out\s+of\s+credits|余额不足|账户余额)",
    re.IGNORECASE,
)
# Upstream 404 that names a missing / denied *model* (not a wrong base_url path).
_MODEL_404_CODES = frozenset(
    {
        "resource_not_found",
        "model_not_found",
        "model_not_available",
        "invalid_model",
        "unknown_model",
    }
)
_MODEL_404_MARKERS = re.compile(
    r"(not\s+found\s+the\s+model|model[\s_-]?(not[\s_-]?found|does[\s_-]?not[\s_-]?exist|"
    r"unknown|invalid|unavailable)|resource_not_found|"
    r"permission\s+denied.*model|model.*permission\s+denied|"
    r"找不到.*模型|模型.*(不存在|不可用|未找到|无权限))",
    re.IGNORECASE,
)
# Structured upstream error.message only (already extracted) — not free-text hard gate.
# Anthropic: ``temperature` is deprecated``; Moonshot: ``invalid temperature: only 1 is allowed``.
_TEMPERATURE_DEPRECATED_MARKERS = re.compile(
    r"("
    r"`?temperature`?\s+is\s+deprecated"
    r"|invalid\s+temperature"
    r"|temperature[^.\n]{0,120}?only\s+\d+\s+is\s+allowed"
    r"|only\s+\d+\s+is\s+allowed[^.\n]{0,120}?temperature"
    r")",
    re.IGNORECASE,
)
# Context / prompt overflow (⑦A · 2026-08-08): never echo upstream walls like
# "This model's maximum context length is … you requested …".
_CONTEXT_OVERFLOW_CODES = frozenset(
    {
        "context_length_exceeded",
        "context_overflow",
        "prompt_too_long",
        "input_too_long",
    }
)
_CONTEXT_OVERFLOW_MARKERS = re.compile(
    r"(maximum\s+context\s+length|context_length_exceeded|context\s+overflow|"
    r"prompt\s+is\s+too\s+long|prompt\s+too\s+long|"
    r"exceeds?\s+(the\s+)?(maximum\s+)?context|"
    r"context\s+window|"
    r"输入过长|上下文.*(过长|超限|溢出|超过)|超过.*上下文)",
    re.IGNORECASE,
)
# Product face — short Chinese; upstream body stays in preview / logs only.
_CONTEXT_OVERFLOW_PRODUCT = "对话上下文过长，本轮无法继续。请压缩较早对话后重试"


def is_balance_exhausted(body: bytes | str | None) -> bool:
    """True when the upstream body proves an exhausted balance, whatever the status.

    Vendors disagree on the status code — DeepSeek answers 402, OpenCode Zen answers
    401 with a ``CreditsError`` body — so the body is authoritative here. A bare 401
    carrying no balance marker stays an auth failure.
    """
    preview = body_preview(body)
    if not preview:
        return False
    code = (_extract_upstream_code(preview) or "").strip().lower()
    kind = (_extract_upstream_error_type(preview) or "").strip().lower()
    if code in _BALANCE_BODY_CODES or kind in _BALANCE_BODY_CODES:
        return True
    extracted = _extract_upstream_message(preview) or ""
    return bool(extracted and _BALANCE_MARKERS.search(extracted))


def is_auth_rejection(status_code: int, body: bytes | str | None) -> bool:
    """True when a 401/403 should surface as key/auth failure (not model-not-allowed)."""
    if is_balance_exhausted(body):
        return False
    if status_code == 401:
        return True
    if status_code != 403:
        return False
    preview = body_preview(body)
    code = (_extract_upstream_code(preview) or "").lower()
    if code in _AUTH_BODY_CODES:
        return True
    # Explicit non-auth 403s (model allowlist, etc.) stay as generic client errors.
    if code in {"model_not_allowed", "model_not_found", "insufficient_quota"}:
        return False
    extracted = _extract_upstream_message(preview) or ""
    return bool(_AUTH_BODY_MARKERS.search(extracted))


def is_model_not_found_404(body: bytes | str | None) -> bool:
    """True when an HTTP 404 body points at a missing/denied model id (not a path)."""
    preview = body_preview(body)
    code = (_extract_upstream_code(preview) or "").lower()
    if code in _MODEL_404_CODES:
        return True
    extracted = _extract_upstream_message(preview) or ""
    if extracted and _MODEL_404_MARKERS.search(extracted):
        return True
    # Non-JSON body / raw text still mentioning the model.
    return bool(preview and _MODEL_404_MARKERS.search(preview))


def is_context_overflow(body: bytes | str | None) -> bool:
    """True when upstream rejects the request for context / prompt length."""
    preview = body_preview(body)
    code = (_extract_upstream_code(preview) or "").lower()
    if code in _CONTEXT_OVERFLOW_CODES:
        return True
    extracted = _extract_upstream_message(preview) or ""
    if extracted and _CONTEXT_OVERFLOW_MARKERS.search(extracted):
        return True
    return bool(preview and _CONTEXT_OVERFLOW_MARKERS.search(preview))


def is_temperature_deprecated(body: bytes | str | None) -> bool:
    """True when upstream error.message says temperature is rejected/deprecated.

    Matches the same structured markers as :func:`client_error_message` product
    copy — not free-text hard gate. Used by the omit-temperature retry path.
    """
    extracted = _extract_upstream_message(body_preview(body)) or ""
    return bool(extracted and _TEMPERATURE_DEPRECATED_MARKERS.search(extracted))


def client_error_message(
    provider_name: str, status_code: int, body: bytes | str | None
) -> str:
    extracted = _extract_upstream_message(body_preview(body))
    if status_code == 404:
        if is_model_not_found_404(body):
            if extracted:
                return (
                    f"{provider_name} {extracted}。"
                    "请更换默认模型后重试"
                )
            return f"{provider_name} 指定的模型不可用（404），请更换默认模型后重试"
        if extracted:
            return f"{provider_name} {extracted}"
        return f"{provider_name} 接口地址不可达（404），请检查 base_url 配置"
    # 413 / body-proven overflow: product Chinese only (⑦A) — no upstream wall.
    if status_code == 413 or is_context_overflow(body):
        return _CONTEXT_OVERFLOW_PRODUCT
    if status_code == 400 and is_temperature_deprecated(body):
        return f"{provider_name} 当前模型不接受 temperature 参数，请重试或更换模型"
    if extracted:
        return f"{provider_name} {extracted}"
    if status_code == 400:
        return f"{provider_name} 请求格式被拒绝（400），请检查模型与参数配置"
    return f"{provider_name} 请求被拒绝（{status_code}），请稍后再试"


def upstream_client_error(
    message: str,
    *,
    status: int,
    body: bytes | str | None = None,
) -> LLMError:
    return LLMError(
        message,
        upstream_status=status,
        upstream_body_preview=body_preview(body),
    )


def upstream_error(
    message: str,
    *,
    status: int,
    body: bytes | str | None = None,
    retry_attempts: int = 0,
) -> LLMUpstreamError:
    ctx = LLMErrorContext(
        upstream_status=status,
        upstream_body_preview=body_preview(body),
        retry_attempts=retry_attempts,
    )
    # ``status_code`` deliberately stays the class default 502 (bad gateway): it is
    # the status *we* answer with when relaying a vendor fault, and inference-proxy
    # callers key「our 5xx vs the vendor's」off it. The real upstream status rides in
    # ``details`` and in the message the caller composed.
    return LLMUpstreamError(
        message,
        upstream_status=ctx.upstream_status,
        upstream_body_preview=ctx.upstream_body_preview,
        retry_attempts=ctx.retry_attempts,
    )


def is_retryable_upstream_status(status: int) -> bool:
    """5xx upstream failures are transient; 4xx client errors are not."""
    return status >= 500


def is_non_retryable_client_status(status: int) -> bool:
    """Explicit client/auth/balance failures — never retry."""
    return status in (400, 401, 402, 403)


def error_context_from(exc: BaseException) -> dict[str, int | str | float | None] | None:
    """Extract LLM upstream context for SSE / API payloads."""
    if not isinstance(exc, AgentCoreError):
        return None

    status = exc.details.get("upstream_status")
    retry_after = exc.details.get("retry_after")
    if isinstance(exc, LLMRateLimitError) and retry_after is None:
        retry_after = getattr(exc, "retry_after", None)
    credential_source = exc.details.get("credential_source")

    if (
        status is None
        and retry_after is None
        and not isinstance(exc, LLMRateLimitError)
        and credential_source not in ("user", "platform")
    ):
        return None

    ctx: dict[str, int | str | float | None] = {}
    if status is not None:
        ctx["upstream_status"] = status
        ctx["upstream_body_preview"] = exc.details.get("upstream_body_preview")
        ctx["retry_attempts"] = exc.details.get("retry_attempts", 0)
    if retry_after is not None:
        with contextlib.suppress(TypeError, ValueError):
            ctx["retry_after"] = float(retry_after)
    if credential_source in ("user", "platform"):
        ctx["credential_source"] = credential_source
    # No Sub2API relay diagnosis here on purpose: it describes the *operator's*
    # upstream accounts, and this dict is the user-visible SSE / REST error
    # context. It stays on the log surface (``llm.upstream_error``).
    return ctx or None
