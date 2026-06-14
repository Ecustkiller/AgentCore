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


class ValidationError(AgentCoreError):
    """Input validation failure."""

    code = "VALIDATION_ERROR"
    status_code = 422
