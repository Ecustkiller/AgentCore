"""Exception hierarchy for AgentCore.

All module-specific errors inherit from AgentCoreError.
Each error carries a code, message, and retryable flag for the API layer to translate
into appropriate HTTP responses. Every ``code`` is a member of the single
:class:`~agentcore.core.error_codes.ErrorCode` catalog (the shared directory),
so codes never drift apart from the SSE emitters or the frontend mirror.
"""

from datetime import UTC, datetime, timedelta

from agentcore.core.error_codes import ErrorCode


class AgentCoreError(Exception):
    """Base exception for all AgentCore errors."""

    code: str = ErrorCode.INTERNAL_ERROR
    retryable: bool = False
    status_code: int = 500

    def __init__(self, message: str = "", **kwargs):
        self.message = message
        self.details = kwargs
        super().__init__(message)


class LLMError(AgentCoreError):
    """LLM provider call failure."""

    code: str = ErrorCode.LLM_ERROR
    status_code = 502


class LLMUpstreamError(LLMError):
    """Upstream provider returned 5xx (transient server error). Retryable."""

    retryable = True


class OurServiceUnavailableError(LLMError):
    """Our own cloud hop (inference proxy / gateway) failed — not the model vendor.

    Stays inside the LLM error family so the provider keeps its retry budget and
    its「already committed partial content」handling, while ``code`` names the real
    fault so the bubble never blames the user's Base URL / API Key. ``code`` and
    ``retryable`` are stamped per instance from the wire envelope.
    """

    code: str = ErrorCode.INTERNAL_ERROR
    status_code = 503
    retryable = True


# Longest upstream ``Retry-After`` an interactive turn will actually sit out.
# Single source for two decisions that must never drift apart: the provider retry
# loop refuses to sleep past it (``llm.provider.openai_compatible``), and the 429
# faces below refuse to keep advertising a retry nobody will attempt.
MAX_RETRY_AFTER = 30.0


def format_retry_after_moment(retry_after: float, *, now: datetime | None = None) -> str:
    """Wall-clock UTC moment a ``retry_after``-second cooldown ends at.

    Day-scale ``Retry-After`` values are upstream day resets, so the honest thing
    to show is when service returns — never「等 16.6 小时」, which reads as a
    promise no retry budget ever made. UTC is stamped explicitly (the quota gate's
    「明日 0 点（UTC）重置」convention) instead of the server's local zone, which
    is not the user's.
    """
    base = now.astimezone(UTC) if now is not None else datetime.now(UTC)
    moment = base + timedelta(seconds=retry_after)
    return f"{moment.month} 月 {moment.day} 日 {moment:%H:%M}（UTC）"


class LLMRateLimitError(LLMError):
    """LLM API rate limit hit (429). User-facing zh message.

    Retryable only while the cooldown fits an interactive turn. Past
    :data:`MAX_RETRY_AFTER` the provider loop already refuses to retry, so the
    error stops saying「请稍后再试」and names the moment upstream frees up
    instead — otherwise the user obeys copy the engine has already overruled
    and burns a handful of guaranteed-failing retries.

    Inside the ceiling the copy still says「再试」but never「点重试」: the red
    error card carries no retry control (定案 A), so naming a button sends the
    user hunting for one. Re-sending the message is the real next step.

    Platform-funded turns take the ``QUOTA_EXCEEDED`` face for that same long
    cooldown: build 429s through :func:`upstream_rate_limit_error` so the split
    by credential source happens in one place.
    """

    code = ErrorCode.LLM_RATE_LIMIT
    retryable = True

    def __init__(
        self,
        retry_after: float | None = None,
        *,
        now: datetime | None = None,
        **kwargs,
    ):
        self.retry_after = retry_after
        if retry_after is not None and retry_after > MAX_RETRY_AFTER:
            self.retryable = False
            # BYOK: the throttled allowance is the user's own; unknown source
            # stays on the vaguer「上游额度」rather than guessing whose key it is.
            whose = (
                "你的服务商额度"
                if kwargs.get("credential_source") == "user"
                else "上游额度"
            )
            message = (
                f"上游限流，本回合无法继续。{whose}将于 "
                f"{format_retry_after_moment(retry_after, now=now)} 恢复，"
                "在此之前重试仍会失败。"
            )
        elif retry_after is not None and 0 < retry_after <= MAX_RETRY_AFTER:
            message = f"上游限流，暂时无法继续本回合。请约 {int(retry_after)} 秒后再试。"
        else:
            message = "上游限流，暂时无法继续本回合。请稍后再试。"
        # retry_after 进 details，供 SSE ErrorContext / history 复用。
        super().__init__(message, retry_after=retry_after, **kwargs)


class LLMQuotaExceededError(LLMError):
    """Our own cloud hop refused the call because a usage quota is exhausted.

    The sidecar leaf reaches models through ``/inference/``, which answers
    ``QUOTA_EXCEEDED`` for a fault only the cloud can see: the user's allowance is
    spent. Distinct from :class:`LLMRateLimitError` — nothing clears on its own, so
    retrying only burns a minute of backoff before repeating the same refusal, and
    the remedy is the ``QUOTA_EXCEEDED`` CTA (wait for reset / bring your own key)
    rather than「稍后再试」.

    Wire twin of :class:`QuotaExceededError` (route preflight, HTTP 429) for the
    leaf side of that hop: same code, but an ``LLMError`` so the provider retry loop
    and the turn's error surfacing treat it like any other leaf failure.

    Also the face a *vendor* 429 takes when a platform key draws a cooldown longer
    than :data:`MAX_RETRY_AFTER` (:func:`upstream_rate_limit_error`): to the user
    that is the same wall — an operator-owned allowance they cannot clear.
    """

    code = ErrorCode.QUOTA_EXCEEDED
    status_code = 429
    retryable = False

    _DEFAULT_MESSAGE = (
        "额度已用完，本回合无法继续。请等待额度重置，"
        "或在「设置 · 服务商」接入自己的 API Key。"
    )

    def __init__(self, message: str | None = None, **kwargs):
        super().__init__(message or self._DEFAULT_MESSAGE, **kwargs)


def upstream_rate_limit_error(
    retry_after: float | None,
    *,
    credential_source: str | None = None,
    now: datetime | None = None,
    **details,
) -> LLMError:
    """Product face for an upstream 429, split by who funds the key.

    Inside :data:`MAX_RETRY_AFTER` this is an ordinary retryable rate limit.
    Past it the turn is not retried at all, and the two credential sources need
    different exits: a platform-funded call hit an allowance wall the user cannot
    clear, so it takes the ``QUOTA_EXCEEDED`` face (client suppresses retry and
    offers「接入自己的 Key」); BYOK keeps the rate-limit face, since telling a user
    who already brought their own key to bring one is nonsense. An unknown source
    takes the BYOK-free conservative branch rather than guessing a platform wall.
    """
    if credential_source in ("user", "platform"):
        details["credential_source"] = credential_source
    if (
        retry_after is not None
        and retry_after > MAX_RETRY_AFTER
        and details.get("credential_source") == "platform"
    ):
        return LLMQuotaExceededError(
            "平台模型额度已用完，本回合无法继续。上游将于 "
            f"{format_retry_after_moment(retry_after, now=now)} 恢复；"
            "或在「设置 · 服务商」接入自己的 API Key 立即继续。",
            retry_after=retry_after,
            **details,
        )
    return LLMRateLimitError(retry_after, now=now, **details)


class LLMTimeoutError(LLMError):
    """LLM API request timed out."""

    code = ErrorCode.LLM_TIMEOUT
    retryable = True


class LLMInsufficientBalanceError(LLMError):
    """Configured API key reached the upstream but the account balance is
    exhausted (typically HTTP 402 Insufficient Balance) — any OpenAI-compatible
    vendor, not DeepSeek-only.

    Distinct from ``BYOKKeyMissingError`` (no key at all, refused at the route
    preflight before the stream opens): here a *valid* key fails mid-turn, so the
    error surfaces as an inline ``error`` event rather than a 402 JSON response. Not
    retryable — an immediate retry just re-fails until the user tops up. Copy is
    vendor-neutral (the key is fine; the balance is not).
    """

    code = ErrorCode.LLM_INSUFFICIENT_BALANCE
    retryable = False

    # Platform keys are operator-owned: the end user cannot top them up, so the
    # copy offers the BYOK exit instead of a 充值 instruction they cannot act on.
    _PLATFORM_MESSAGE = (
        "平台模型暂时不可用（上游账户余额不足）。请改用自己的 API Key，或联系管理员。"
    )

    def __init__(
        self,
        message: str | None = None,
        *,
        provider_name: str | None = None,
        display_name: str | None = None,
        **kwargs,
    ):
        if message is None:
            name = (provider_name or "").strip()
            shown = (display_name or "").strip()
            if name == "platform":
                message = self._PLATFORM_MESSAGE
            else:
                if shown:
                    label = shown
                elif name and name != "user":
                    label = name
                else:
                    label = "服务商"
                message = f"{label} API Key 有效，但账户余额不足，请充值后重试。"
        if provider_name is not None and "provider_name" not in kwargs:
            kwargs["provider_name"] = provider_name
        if "credential_source" not in kwargs:
            name = (provider_name or "").strip()
            kwargs["credential_source"] = "platform" if name == "platform" else "user"
        super().__init__(message, **kwargs)


# Single source for「你还没配 key」across the leaf error and the route preflights
# (conversations / inference proxy pass it as ``byok_missing_message``). It named a
# 「模型配置」page that never existed, and the rename had to touch four copies —
# one constant so the next wording change is one edit.
BYOK_KEY_REQUIRED_MESSAGE = "请先在「设置 · 服务商」中填入你的 API Key，再发起对话。"


class LLMKeyRequiredError(LLMError):
    """A turn reached the model hop with no BYOK key configured at all.

    Wire twin of :class:`BYOKKeyMissingError` (route preflight, HTTP 402) for the
    sidecar leaf: the cloud ``/inference/`` hop refuses before it ever contacts a
    vendor, and the leaf must keep the ``LLM_KEY_REQUIRED`` code so the client
    routes to 设置·服务商. Distinct from :class:`LLMInsufficientBalanceError` —
    there is no key and no account to top up, so 充值 is the wrong remedy — and not
    retryable, since only the user adding a key can change the outcome.

    Copy names 服务商 because that is the settings page keys actually live on;
    「模型配置」 was a page this product never shipped.
    """

    code = ErrorCode.LLM_KEY_REQUIRED
    status_code = 402
    retryable = False

    _DEFAULT_MESSAGE = BYOK_KEY_REQUIRED_MESSAGE

    def __init__(self, message: str | None = None, **kwargs):
        super().__init__(message or self._DEFAULT_MESSAGE, **kwargs)


class LLMAuthError(LLMError):
    """Configured API key rejected upstream (HTTP 401/403): invalid, revoked,
    or lacking permission — for any provider (BYOK DeepSeek, platform Claude, …).

    Distinct from ``BYOKKeyMissingError`` (no key at all, refused at preflight): a
    *configured* key fails mid-turn, so it surfaces as an inline ``error`` event. Not
    retryable — re-sending with the same bad key just re-fails — and its message (and
    the ``LLM_KEY_INVALID`` code, which the client maps to a "去配置" action) routes
    the user back to 设置·服务商 to fix the key.

    Platform keys are operator-owned: default copy must not echo upstream gateway
    help (e.g. CC Switch tutorials) or the internal provider label ``platform``.
    """

    code = ErrorCode.LLM_KEY_INVALID
    retryable = False

    _PLATFORM_MESSAGE = "平台模型暂时不可用（上游鉴权失败）。请改用自己的 API Key，或联系管理员。"

    def __init__(
        self,
        message: str | None = None,
        *,
        provider_name: str | None = None,
        display_name: str | None = None,
        **kwargs,
    ):
        name = (provider_name or "").strip()
        shown = (display_name or "").strip()
        if message is None:
            if name == "platform":
                message = self._PLATFORM_MESSAGE
            else:
                if shown:
                    label = shown
                elif name and name != "user":
                    label = name
                else:
                    label = "服务商"
                message = f"{label} API Key 无效或无权限，请在「设置 · 服务商」中更新后重试。"
        # Wire CTA 分流：platform → 接入自己的 Key；user/BYOK → 去设置换 Key。
        if "credential_source" not in kwargs:
            kwargs["credential_source"] = "platform" if name == "platform" else "user"
        if provider_name is not None and "provider_name" not in kwargs:
            kwargs["provider_name"] = provider_name
        super().__init__(message, **kwargs)


class InferenceTokenExpiredError(LLMAuthError):
    """Sidecar→cloud inference proxy JWT rejected (invalid / expired).

    Distinct from BYOK ``LLM_KEY_INVALID``: the user should remint / re-login /
    retry the turn — not open「设置 · 服务商」to edit an API key. ``retryable``
    so the desktop can clear the cache, mint once, and retry the turn.
    """

    code = ErrorCode.INFERENCE_TOKEN_EXPIRED
    retryable = True

    # 「再试」= 重发本条消息：红错误卡不挂重试按钮（定案 A），点名一个按钮只会让人白找。
    _DEFAULT_MESSAGE = (
        "本地与云端的推理凭证已失效或过期。请稍后再试（将自动换新凭证）；仍失败请重新登录后再试。"
    )

    def __init__(self, message: str | None = None, **kwargs):
        # Bypass LLMAuthError's BYOK「去设置」default copy.
        LLMError.__init__(self, message or self._DEFAULT_MESSAGE, **kwargs)


class LLMClientClosedError(LLMError):
    """httpx client was closed while a caller still tried to send (turn teardown race).

    Coordination background drives clone an independent client so chat-turn
    ``llm.close()`` cannot hit in-flight workers; residual paths that still share a
    closed client must not burn WaveScheduler infra retries — re-POST on the same
    closed client is deterministic failure.
    """

    code = ErrorCode.LLM_ERROR
    retryable = False

    def __init__(
        self,
        message: str = "Cannot send a request, as the client has been closed.",
        **kwargs,
    ):
        super().__init__(message, **kwargs)


class LLMInvalidResponseError(LLMError):
    """Upstream returned HTTP 2xx but the body is not usable JSON.

    Typical BYOK/gateway cases: HTML login page, reverse-proxy interstitial, or
    other non-OpenAI shells. Not retryable — the same endpoint will keep returning
    the same shell. Side-path logs classify this as ``invalid_response`` so it
    does not drown in the ``other`` bucket.
    """

    code = ErrorCode.LLM_ERROR
    retryable = False


def is_llm_client_closed_error(exc: BaseException) -> bool:
    """True for typed closed-client errors or httpx's RuntimeError wording."""
    if isinstance(exc, LLMClientClosedError):
        return True
    if isinstance(exc, RuntimeError):
        return "client has been closed" in str(exc).lower()
    return False


class ToolError(AgentCoreError):
    """Tool execution failure."""

    code = ErrorCode.TOOL_ERROR
    status_code = 500


class ToolNotFoundError(ToolError):
    """Requested tool not registered."""

    code = ErrorCode.TOOL_NOT_FOUND
    status_code = 404


class SandboxError(AgentCoreError):
    """Code sandbox execution failure."""

    code = ErrorCode.SANDBOX_ERROR
    status_code = 500


class SandboxTimeoutError(SandboxError):
    """Code execution exceeded timeout."""

    code = ErrorCode.SANDBOX_TIMEOUT


class AuthenticationError(AgentCoreError):
    """Authentication failure."""

    code = ErrorCode.AUTH_ERROR
    status_code = 401


class AuthorizationError(AgentCoreError):
    """Authorization/permission failure."""

    code = ErrorCode.FORBIDDEN
    status_code = 403


class AdminProductForbiddenError(AuthorizationError):
    """Admin accounts cannot authenticate on product clients (desktop / mobile)."""

    code = ErrorCode.ADMIN_PRODUCT_FORBIDDEN

    def __init__(self, message: str = "管理员账号请使用管理后台登录", **kwargs):
        super().__init__(message, **kwargs)


class MfaRequiredError(AgentCoreError):
    """Password verified; TOTP step still pending."""

    code = ErrorCode.MFA_REQUIRED
    status_code = 401


class MfaSetupRequiredError(AgentCoreError):
    """Admin session exists but MFA enrollment is incomplete."""

    code = ErrorCode.MFA_SETUP_REQUIRED
    status_code = 428


class NotFoundError(AgentCoreError):
    """Resource not found."""

    code = ErrorCode.NOT_FOUND
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

    code = ErrorCode.CONFLICT
    status_code = 409


class ValidationError(AgentCoreError):
    """Input validation failure."""

    code = ErrorCode.VALIDATION_ERROR
    status_code = 422


class PayloadTooLargeError(ValidationError):
    """Request / download payload exceeds a configured byte ceiling (HTTP 413).

    Reuses ``VALIDATION_ERROR`` so clients already treating validation as
    non-retriable keep working; status is 413 so oversized panel downloads are
    distinct from generic 422 path/UTF-8 problems and never collapse to 500.
    """

    status_code = 413


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

    code = ErrorCode.RATE_LIMITED
    status_code = 429

    def __init__(self, message: str = "", *, retry_after: float | None = None, **kwargs):
        self.retry_after = retry_after
        super().__init__(message, retry_after=retry_after, **kwargs)


class QuotaExceededError(AgentCoreError):
    """A configured usage quota is exhausted; the next turn is refused.

    Three independent dimensions (daily tokens / monthly cost / daily requests),
    checked before a turn starts (成本配额与计费.md §一). Maps to HTTP 429 so the
    client can surface a "quota reached" state distinct from auth (401) or
    validation (422). ``dimension`` / ``used`` / ``limit`` ride along on the
    exception for logging and tests.

    Leaf-side twin (same code, inside the LLM family): :class:`LLMQuotaExceededError`.
    """

    code = ErrorCode.QUOTA_EXCEEDED
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


class BYOKKeyMissingError(AgentCoreError):
    """No usable BYOK LLM key is configured, so a turn cannot start.

    In BYOK billing mode every user-facing turn runs on the user's own API key;
    with none configured the turn is refused *before* the SSE opens (route preflight)
    so the client can route the user to 设置·服务商 rather than getting a
    half-opened stream. 402 Payment Required fits "you must supply your own
    billing credentials to proceed", and the ``LLM_KEY_REQUIRED`` code lets the
    client distinguish it from auth (401) / quota (429).

    Leaf-side twin (same code, inside the LLM family): :class:`LLMKeyRequiredError`.
    """

    code = ErrorCode.LLM_KEY_REQUIRED
    status_code = 402


class PlatformBillingUnavailableError(AgentCoreError):
    """User chose platform free quota but the operator key is not configured."""

    code = ErrorCode.PLATFORM_BILLING_UNAVAILABLE
    status_code = 503


class ResumeJournalDegradedError(AgentCoreError):
    """A durable pause frame survived but its ``turn_journal`` mirror did not.

    Resume cannot rebuild the CEO window from facts alone; the user must abandon the
    paused turn and start fresh rather than continuing on a silently empty context.
    """

    code = ErrorCode.STREAM_ERROR


class KeyStorageUnavailableError(AgentCoreError):
    """The server cannot store or read BYOK keys because no encryption master key
    is configured (settings.encryption_key).

    BYOK requires AES-256-GCM at-rest encryption (security.KeyEncryptor); without
    the master key the set-key endpoint refuses to store a key it could never read
    back (fail-safe: plaintext never lands on disk). 503 Service Unavailable —
    it's a server misconfiguration, not the user's fault, and is fixable by
    setting ENCRYPTION_KEY and restarting.
    """

    code = ErrorCode.KEY_STORAGE_UNAVAILABLE
    status_code = 503


class DatabaseUnavailableError(AgentCoreError):
    """Primary DB pool exhausted or database unreachable for this request.

    Maps to HTTP 503 with a stable product sentence (not a raw QueuePool /
    driver traceback). Retryable: pool pressure and brief outages clear on
    their own. Distinct from readiness: ``database_ready`` uses an isolated
    probe connection so K8s does not confuse pool exhaustion with PG down.
    """

    code = ErrorCode.DATABASE_UNAVAILABLE
    status_code = 503
    retryable = True

    def __init__(self, message: str = "AgentCore 服务暂时不可用，请稍后重试", **kwargs):
        super().__init__(message, **kwargs)


class ClientTooOldError(AgentCoreError):
    """Desktop client build is below ``DESKTOP_MIN_VERSION`` (HTTP 426).

    Global desktop floor enforced by middleware on ``/v1/*`` when
    ``X-Client-Platform=desktop``. Empty min version / missing or ``dev`` client
    version / compare failure all fail-open (see middleware). Not the §7.9
    per-flag ``min_client_version`` gate.
    """

    code = ErrorCode.CLIENT_TOO_OLD
    status_code = 426

    def __init__(
        self,
        message: str = "桌面端版本过旧，请更新后再试",
        *,
        min_version: str = "",
        **kwargs,
    ):
        self.min_version = min_version
        if min_version and "最低版本" not in message:
            message = f"{message}（最低版本 {min_version}）"
        super().__init__(message, min_version=min_version, **kwargs)


# Product-face fallback when an unclassified exception hits a user-facing boundary.
# Same sentence as ``message_merge.DEFAULT_FAILED_ERROR_MESSAGE`` (settle / usage).
UNCLASSIFIED_EXCEPTION_USER_MESSAGE = "模型调用失败，请稍后重试。"


def error_fields_for(
    exc: BaseException,
    *,
    fallback_code: str,
    fallback_message: str,
) -> tuple[str, str, dict | None]:
    """Decide the ``(code, message, context)`` a product-facing error should carry.

    Category gate (not string matching):
    - :class:`AgentCoreError` — pass through coded product copy on the type.
    - Sticky-dead :class:`~agentcore.workspace.protocol.WorkspaceIOError` — honest
      channel-down zh already on the exception (product text by construction).
    - Everything else (dev invariants, third-party, unclassified) — the caller's
      curated ``fallback_message``, never ``str(exc)``. Callers own that copy and
      must pass product text (an empty one degrades to
      :data:`UNCLASSIFIED_EXCEPTION_USER_MESSAGE`); the exception's own text is
      for logs.
    """
    if isinstance(exc, AgentCoreError):
        from agentcore.llm.errors import error_context_from

        return (
            exc.code,
            (exc.message or fallback_message),
            error_context_from(exc),
        )
    # Local workspace sticky-dead / presence-gate during prepare / turn gate:
    # surface the honest WorkspaceIOError text (not the generic STREAM_ERROR
    # fallback) so the UI can clear isStreaming with a clear channel-down reason.
    from agentcore.runtime.pipeline.errors import (
        LOCAL_CHANNEL_DEAD,
        is_prepare_local_abort_message,
    )
    from agentcore.workspace.limits import is_channel_dead_detail
    from agentcore.workspace.protocol import WorkspaceIOError

    if isinstance(exc, WorkspaceIOError):
        detail = str(exc).strip()
        if is_prepare_local_abort_message(detail) or is_channel_dead_detail(detail):
            return (
                ErrorCode.STREAM_ERROR,
                detail or LOCAL_CHANNEL_DEAD,
                None,
            )
    product = (fallback_message or "").strip()
    return fallback_code, product or UNCLASSIFIED_EXCEPTION_USER_MESSAGE, None
