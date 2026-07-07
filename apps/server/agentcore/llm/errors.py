"""LLM error context helpers — unified upstream diagnostics."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import StrEnum

from agentcore.core.errors import AgentCoreError, LLMUpstreamError

_BODY_PREVIEW_MAX = 500


class EmptyResponseDiagnosis(StrEnum):
    OAUTH_EXPIRED = "oauth_expired"
    CONTENT_FILTERED = "content_filtered"
    MODEL_UNKNOWN = "model_unknown"
    SILENT_EMPTY = "silent_empty"
    FORMAT_MISMATCH = "format_mismatch"


_OAUTH_MARKERS = re.compile(
    r"(<html|</html>|<!doctype|oauth|sign[\s_-]?in|login|unauthorized|access[\s_-]?denied)",
    re.IGNORECASE,
)
_MODEL_UNKNOWN_MARKERS = re.compile(
    r"(model[\s_-]?(not[\s_-]?found|does[\s_-]?not[\s_-]?exist|unknown|invalid)|"
    r"unknown[\s_-]?model|invalid[\s_-]?model)",
    re.IGNORECASE,
)

_DIAGNOSIS_LABELS: dict[EmptyResponseDiagnosis, str] = {
    EmptyResponseDiagnosis.OAUTH_EXPIRED: "模型无响应 · 可能需要刷新 Sub2API OAuth",
    EmptyResponseDiagnosis.CONTENT_FILTERED: "内容被过滤",
    EmptyResponseDiagnosis.MODEL_UNKNOWN: "模型名未被上游识别",
    EmptyResponseDiagnosis.SILENT_EMPTY: "模型返回空内容",
    EmptyResponseDiagnosis.FORMAT_MISMATCH: "上游响应格式异常",
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
    text = (raw_body or "").strip()
    if text and _OAUTH_MARKERS.search(text):
        return EmptyResponseDiagnosis.OAUTH_EXPIRED
    if text and _MODEL_UNKNOWN_MARKERS.search(text):
        return EmptyResponseDiagnosis.MODEL_UNKNOWN
    if text:
        try:
            data = json.loads(text)
            if isinstance(data, dict) and data.get("error"):
                err = data["error"]
                err_text = err if isinstance(err, str) else json.dumps(err, ensure_ascii=False)
                if _OAUTH_MARKERS.search(err_text):
                    return EmptyResponseDiagnosis.OAUTH_EXPIRED
                if _MODEL_UNKNOWN_MARKERS.search(err_text):
                    return EmptyResponseDiagnosis.MODEL_UNKNOWN
        except json.JSONDecodeError:
            if "<" in text and ">" in text:
                return EmptyResponseDiagnosis.OAUTH_EXPIRED
            return EmptyResponseDiagnosis.FORMAT_MISMATCH
    return EmptyResponseDiagnosis.SILENT_EMPTY


def empty_response_event_message(diagnosis: str | EmptyResponseDiagnosis | None) -> str:
    """User-facing SSE error message for a degraded empty-response finish."""
    base = "模型多次空响应"
    if diagnosis is None:
        return base
    try:
        key = EmptyResponseDiagnosis(diagnosis)
    except ValueError:
        return f"{base} · {diagnosis}"
    label = _DIAGNOSIS_LABELS.get(key)
    return f"{base} · {label}" if label else base


def empty_response_chip_label(diagnosis: str | EmptyResponseDiagnosis | None) -> str | None:
    """Short label for the degraded finish-reason chip (diagnosis only)."""
    if diagnosis is None:
        return None
    try:
        key = EmptyResponseDiagnosis(diagnosis)
    except ValueError:
        return str(diagnosis)
    return _DIAGNOSIS_LABELS.get(key)


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
    return LLMUpstreamError(
        message,
        upstream_status=ctx.upstream_status,
        upstream_body_preview=ctx.upstream_body_preview,
        retry_attempts=ctx.retry_attempts,
    )


def error_context_from(exc: BaseException) -> dict[str, int | str | None] | None:
    """Extract LLM upstream context for SSE / API payloads."""
    if not isinstance(exc, AgentCoreError):
        return None
    status = exc.details.get("upstream_status")
    if status is None:
        return None
    ctx: dict[str, int | str | None] = {
        "upstream_status": status,
        "upstream_body_preview": exc.details.get("upstream_body_preview"),
        "retry_attempts": exc.details.get("retry_attempts", 0),
    }
    if exc.details.get("sub2api_diagnosis"):
        ctx["sub2api_diagnosis"] = exc.details["sub2api_diagnosis"]
    if exc.details.get("sub2api_account"):
        ctx["sub2api_account"] = exc.details["sub2api_account"]
    return ctx
