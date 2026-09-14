"""Product-facing ``(code, message, context)`` for SSE / HTTP error envelopes.

Lives above ``core`` so it can attach LLM upstream context without making
``core.errors`` import ``llm``. Types and copy stay on the exception classes.
"""

from __future__ import annotations

from agentcore.core.errors import UNCLASSIFIED_EXCEPTION_USER_MESSAGE, AgentCoreError
from agentcore.llm.errors import error_context_from


def error_fields_for(
    exc: BaseException,
    *,
    fallback_code: str,
    fallback_message: str,
) -> tuple[str, str, dict | None]:
    """Decide the ``(code, message, context)`` a product-facing error should carry.

    Category gate (not string matching):
    - :class:`AgentCoreError` — pass through coded product copy on the type.
    - Everything else (dev invariants, third-party, unclassified) — the caller's
      curated ``fallback_message``, never ``str(exc)``. Callers own that copy and
      must pass product text (an empty one degrades to
      :data:`~agentcore.core.errors.UNCLASSIFIED_EXCEPTION_USER_MESSAGE`); the
      exception's own text is for logs.
    """
    if isinstance(exc, AgentCoreError):
        return (
            exc.code,
            (exc.message or fallback_message),
            error_context_from(exc),
        )
    product = (fallback_message or "").strip()
    return fallback_code, product or UNCLASSIFIED_EXCEPTION_USER_MESSAGE, None
