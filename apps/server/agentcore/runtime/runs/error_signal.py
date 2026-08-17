"""Read transient/terminal error signals from the LLM / core error types.

Classification lives on ``agentcore.core.errors`` (``llm_failure_class`` /
``code`` / ``retry_after``) + ``agentcore.llm.errors.error_context_from``.
This module only projects those attributes onto run state and ``run_failed``
— it does not invent a second taxonomy.

``exc.retryable`` is the leaf's remaining HTTP budget (``mark_llm_leaf_exhausted``
flips it False). Rate limits stay ``transient`` after that flip; run-level
code must read :func:`llm_failure_class`, not ``retryable``.
"""

from __future__ import annotations

from dataclasses import dataclass

from agentcore.core.errors import (
    LLM_FAILURE_TRANSIENT,
    RETRY_AFTER_FROM_HEADER,
    LLMClientClosedError,
    is_llm_client_closed_error,
    llm_failure_class,
)
from agentcore.llm.errors import error_context_from


@dataclass(frozen=True, slots=True)
class RunErrorSignal:
    """Wire-facing error fields for one run failure.

    ``retryable`` is ``llm_failure_class == transient`` — 「等一下会好」vs
    「等也没用」. Distinct from the leaf's HTTP-budget ``exc.retryable``.
    """

    error_code: str | None
    retryable: bool
    retry_after: float | None
    exc: BaseException


def run_error_signal(exc: BaseException) -> RunErrorSignal:
    """Project an exception onto ``error_code`` / ``retryable`` / ``retry_after``.

    Closed httpx client (turn teardown race) is normalized to
    :class:`LLMClientClosedError` so the class is ``terminal``. ``retryable``
    on the returned signal is :func:`llm_failure_class` (rate-limit stays
    transient after :func:`mark_llm_leaf_exhausted`).
    """
    if is_llm_client_closed_error(exc) and not isinstance(exc, LLMClientClosedError):
        exc = LLMClientClosedError(str(exc))
    retryable = llm_failure_class(exc) == LLM_FAILURE_TRANSIENT
    raw_code = getattr(exc, "code", None)
    error_code = raw_code if isinstance(raw_code, str) and raw_code else None
    retry_after = getattr(exc, "retry_after", None)
    source = getattr(exc, "retry_after_source", None)
    if source is not None and source != RETRY_AFTER_FROM_HEADER:
        # LLM 429 whose seconds are our backoff / unknown: not 上游 Retry-After.
        retry_after = None
    if retry_after is None:
        ctx = error_context_from(exc)
        if ctx is not None:
            retry_after = ctx.get("retry_after")
    parsed: float | None
    try:
        parsed = float(retry_after) if retry_after is not None else None
    except (TypeError, ValueError):
        parsed = None
    if parsed is not None and parsed < 0:
        parsed = None
    return RunErrorSignal(
        error_code=error_code,
        retryable=retryable,
        retry_after=parsed,
        exc=exc,
    )
