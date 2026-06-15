"""Exception hierarchy for AgentCore.

All module-specific errors inherit from AgentCoreError.
Each error carries a code, message, and retryable flag for the API layer to translate
into appropriate HTTP responses.
"""


class AgentCoreError(Exception):
    """Base exception for all AgentCore errors."""

    code: str = "INTERNAL_ERROR"
    retryable: bool = False
    status_code: int = 500

    def __init__(self, message: str = "", **kwargs):
        self.message = message
        self.details = kwargs
        super().__init__(message)


class LLMError(AgentCoreError):
    """LLM provider call failure."""

    code = "LLM_ERROR"
    status_code = 502


class LLMRateLimitError(LLMError):
    """LLM API rate limit hit (429)."""

    code = "LLM_RATE_LIMIT"
    retryable = True

    def __init__(self, retry_after: float | None = None, **kwargs):
        self.retry_after = retry_after
        super().__init__(f"Rate limited. Retry after {retry_after}s", **kwargs)


class LLMTimeoutError(LLMError):
    """LLM API request timed out."""

    code = "LLM_TIMEOUT"
    retryable = True


class ToolError(AgentCoreError):
    """Tool execution failure."""

    code = "TOOL_ERROR"
    status_code = 500


class ToolNotFoundError(ToolError):
    """Requested tool not registered."""

    code = "TOOL_NOT_FOUND"
    status_code = 404


class SandboxError(AgentCoreError):
    """Code sandbox execution failure."""

    code = "SANDBOX_ERROR"
    status_code = 500


class SandboxTimeoutError(SandboxError):
    """Code execution exceeded timeout."""

    code = "SANDBOX_TIMEOUT"


class AuthenticationError(AgentCoreError):
    """Authentication failure."""

    code = "AUTH_ERROR"
    status_code = 401


class AuthorizationError(AgentCoreError):
    """Authorization/permission failure."""

    code = "FORBIDDEN"
    status_code = 403


class NotFoundError(AgentCoreError):
    """Resource not found."""

    code = "NOT_FOUND"
    status_code = 404


class ConflictError(AgentCoreError):
    """Request conflicts with the resource's current state (HTTP 409).

    e.g. moving a *started* conversation between folders: its folder decides which
    workspace directory it runs in — and whether cloud or local (双模式工作区 §七:
    folder = project = workspace) — so re-filing a chat that has already
    accumulated files would silently re-point it at a different directory. The
    workspace is fixed once a conversation has any messages, so the move is refused
    rather than quietly switching it.
    """

    code = "CONFLICT"
    status_code = 409


class ValidationError(AgentCoreError):
    """Input validation failure."""

    code = "VALIDATION_ERROR"
    status_code = 422


class RateLimitedError(AgentCoreError):
    """Too many requests in a rolling window; this one is refused (HTTP 429).

    The 速率 line of defense (成本配额与计费.md §一), orthogonal to 配额 (总量):
    rate limiting caps requests-per-window, quota caps cumulative usage. Per-user
    message-send throttling is enforced at the route layer against the authenticated
    user. ``retry_after`` (seconds) rides along so the API layer can emit a
    ``Retry-After`` header and the client can show a friendly cool-down. Reuses the
    ``RATE_LIMITED`` code shared with the auth-endpoint limiter so the client handles
    one rate-limit shape regardless of which layer tripped.
    """

    code = "RATE_LIMITED"
    status_code = 429

    def __init__(
        self, message: str = "", *, retry_after: float | None = None, **kwargs
    ):
        self.retry_after = retry_after
        super().__init__(message, retry_after=retry_after, **kwargs)


class QuotaExceededError(AgentCoreError):
    """A configured usage quota is exhausted; the next turn is refused.

    Three independent dimensions (daily tokens / monthly cost / daily requests),
    checked before a turn starts (成本配额与计费.md §一). Maps to HTTP 429 so the
    client can surface a "quota reached" state distinct from auth (401) or
    validation (422). ``dimension`` / ``used`` / ``limit`` ride along on the
    exception for logging and tests.
    """

    code = "QUOTA_EXCEEDED"
    status_code = 429

    def __init__(
        self,
        message: str = "",
        *,
        dimension: str = "",
        used: int = 0,
        limit: int = 0,
        **kwargs,
    ):
        self.dimension = dimension
        self.used = used
        self.limit = limit
        super().__init__(message, dimension=dimension, used=used, limit=limit, **kwargs)
