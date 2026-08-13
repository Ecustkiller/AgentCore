"""Push transport port + FCM v1 adapter (原生推送下发, 认证与会话 §十).

A :class:`PushSender` is pure transport: given device tokens + a notification it
delivers, and reports back a :class:`PushResult` — what the provider accepted, plus the
tokens it rejected as *unregistered* so the caller can prune them (the DB resolve +
prune lives in :mod:`agentcore.push.notify`). This mirrors the project's port/adapter
posture (cf. ``ChatEventPublisher`` / ``AssetStorage``) so FCM can be swapped (APNs
direct, a test double) without touching trigger code.

The FCM adapter speaks the HTTP **v1** API with a service-account OAuth2 bearer. It needs
**no new dependency**: the bearer is minted by signing the service-account JWT with the
already-present ``python-jose`` (RS256) and exchanging it via the already-present
``httpx`` — so push adds nothing to the install footprint.
"""

from __future__ import annotations

import json
import time
from asyncio import Lock
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from typing import Protocol, runtime_checkable

import httpx

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.net import outbound_async_client

logger = get_logger(__name__)

# Service-account → access-token exchange (Google OAuth2 JWT-bearer flow).
_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
_DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
_HTTP_TIMEOUT = 10.0


@dataclass(frozen=True)
class PushNotification:
    """One notification to deliver. ``data`` values MUST be strings (FCM requirement);
    the client reads them on tap to deep-link (conversation_id / message_id / kind)."""

    title: str
    body: str
    data: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class PushResult:
    """What one fan-out actually achieved.

    Reporting the counts (not just the stale tokens) is what lets a caller — and its
    log line — tell「压根没发」from「发了但没到」: ``accepted`` is the provider's own
    receipt, so a zero there is never dressed up as a delivered push.

    - ``accepted``: tokens the provider took (HTTP 200).
    - ``stale``: tokens it reported unregistered — the caller prunes these.
    - ``failed``: everything else (transport error, quota, 5xx, or a credential
      exchange that never produced a bearer, in which case nothing left the process).
    """

    accepted: int = 0
    stale: tuple[str, ...] = ()
    failed: int = 0


def device_fingerprint(token: str) -> str:
    """Stable 8-hex tag for a device token — logs identify a device, never carry its token.

    The same device keeps the same tag across mint / send / prune lines, so a 真机 session
    is followable end to end without a push credential ever entering the log stream.
    """
    return sha256(token.encode("utf-8")).hexdigest()[:8]


def _accepted_message_id(resp: httpx.Response) -> str:
    """FCM's id for an accepted message (``""`` when the body is not the documented shape).

    This is the one handle that outlives our own logs (FCM console / support ticket), so a
    「发了但没到」can be chased past the point where we stop seeing it. Parsing it must
    never break a send, hence the swallow.
    """
    try:
        name = str(resp.json().get("name", ""))
    except Exception:  # noqa: BLE001 — an unreadable body costs the id, nothing else
        return ""
    return name.rsplit("/", 1)[-1]


@runtime_checkable
class PushSender(Protocol):
    async def send(self, tokens: Sequence[str], notification: PushNotification) -> PushResult:
        """Deliver ``notification`` to each token and report what the provider did.

        The result's ``stale`` tokens are the ones the provider reported unregistered so
        the caller prunes them; its counts are what keep a silent no-op from reading as a
        delivered push. Best-effort: a transport error logs and is swallowed (a missing
        push must never break a turn).
        """
        ...


class NullPushSender:
    """No-op sender (push disabled / unconfigured). Delivers nothing, prunes nothing."""

    async def send(self, tokens: Sequence[str], notification: PushNotification) -> PushResult:
        return PushResult()


class FcmPushSender:
    """FCM HTTP v1 sender with a cached service-account OAuth2 bearer.

    Sends one request per token (simple + lets us map each stale token precisely); for
    the low push volume here (a handful of devices per user, on durable pauses only)
    that is well within budget. A 404 / ``UNREGISTERED`` marks the token dead for pruning.
    """

    def __init__(
        self, *, project_id: str, client_email: str, private_key: str, token_uri: str
    ) -> None:
        self._project_id = project_id
        self._client_email = client_email
        self._private_key = private_key
        self._token_uri = token_uri or _DEFAULT_TOKEN_URI
        self._send_url = f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
        self._access_token: str | None = None
        self._access_token_exp = 0.0
        self._token_lock = Lock()

    async def _bearer(self) -> str | None:
        """A valid access token, minted/cached. ``None`` if the exchange fails (callers
        then skip sending — degraded, not crashed). Serialized so a burst of pushes does
        one refresh, not N."""
        now = time.time()
        # 60s skew margin so an in-flight send never uses an about-to-expire token.
        if self._access_token and now < self._access_token_exp - 60:
            return self._access_token
        async with self._token_lock:
            now = time.time()
            if self._access_token and now < self._access_token_exp - 60:
                return self._access_token
            try:
                from jose import jwt  # local: only a configured FCM build needs jose here

                assertion = jwt.encode(
                    {
                        "iss": self._client_email,
                        "scope": _FCM_SCOPE,
                        "aud": self._token_uri,
                        "iat": int(now),
                        "exp": int(now) + 3600,
                    },
                    self._private_key,
                    algorithm="RS256",
                )
                async with outbound_async_client(timeout=_HTTP_TIMEOUT) as client:
                    resp = await client.post(
                        self._token_uri,
                        data={"grant_type": _JWT_BEARER_GRANT, "assertion": assertion},
                    )
                if resp.status_code != 200:
                    logger.warning(
                        "push.fcm_token_failed",
                        status=resp.status_code,
                        body=resp.text[:200],
                    )
                    return None
                payload = resp.json()
                self._access_token = payload["access_token"]
                expires_in = float(payload.get("expires_in", 3600))
                self._access_token_exp = now + expires_in
                # The one line proving the service account itself works: after this,
                # a missing notification is FCM's or the device's, not our credentials'.
                logger.info(
                    "push.fcm_token_minted",
                    project_id=self._project_id,
                    expires_in=int(expires_in),
                )
                return self._access_token
            except Exception as e:  # noqa: BLE001 — auth failure degrades to "no push"
                logger.warning("push.fcm_token_error", error=str(e))
                return None

    async def send(self, tokens: Sequence[str], notification: PushNotification) -> PushResult:
        if not tokens:
            return PushResult()
        bearer = await self._bearer()
        if not bearer:
            # No bearer ⇒ not one byte left the process. Counted as failed (not as an
            # empty fan-out) so the caller's log can never read as「已发送」.
            return PushResult(failed=len(tokens))
        headers = {"Authorization": f"Bearer {bearer}"}
        accepted = 0
        failed = 0
        dead: list[str] = []
        async with outbound_async_client(timeout=_HTTP_TIMEOUT) as client:
            for token in tokens:
                device = device_fingerprint(token)
                message = {
                    "token": token,
                    "notification": {
                        "title": notification.title,
                        "body": notification.body,
                    },
                }
                if notification.data:
                    message["data"] = notification.data
                try:
                    resp = await client.post(
                        self._send_url, headers=headers, json={"message": message}
                    )
                except Exception as e:  # noqa: BLE001 — one bad send never aborts the fan-out
                    logger.warning("push.fcm_send_error", error=str(e), device=device)
                    failed += 1
                    continue
                if resp.status_code == 200:
                    accepted += 1
                    logger.info(
                        "push.fcm_sent",
                        device=device,
                        message_id=_accepted_message_id(resp),
                    )
                    continue
                # 404 NOT_FOUND or an UNREGISTERED error = the app was uninstalled / token
                # rotated; mark it for pruning. Other non-2xx (quota, 5xx) are transient —
                # log and keep the token for the next attempt.
                if resp.status_code == 404 or "UNREGISTERED" in resp.text:
                    dead.append(token)
                    logger.info("push.fcm_token_stale", device=device, status=resp.status_code)
                else:
                    failed += 1
                    logger.warning(
                        "push.fcm_send_failed",
                        status=resp.status_code,
                        body=resp.text[:200],
                        device=device,
                    )
        return PushResult(accepted=accepted, stale=tuple(dead), failed=failed)


@lru_cache(maxsize=1)
def build_push_sender() -> PushSender:
    """The process-wide sender, chosen from config (cached — built once).

    Returns :class:`NullPushSender` when push is disabled OR the service-account file is
    missing/unreadable/malformed, so a misconfig degrades to "no push" rather than
    failing startup. ``project_id`` comes from settings or the service-account JSON.
    """
    if not settings.push_enabled:
        return NullPushSender()
    path = settings.fcm_service_account_path
    if not path:
        logger.warning("push.fcm_unconfigured")
        return NullPushSender()
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        project_id = settings.fcm_project_id or data["project_id"]
        sender = FcmPushSender(
            project_id=project_id,
            client_email=data["client_email"],
            private_key=data["private_key"],
            token_uri=data.get("token_uri", _DEFAULT_TOKEN_URI),
        )
        # Which Firebase project this process sends from — the fastest way to catch a
        # 真机 registered against project A while the server pushes from project B.
        logger.info("push.fcm_configured", project_id=project_id)
        return sender
    except Exception as e:  # noqa: BLE001 — a bad credential file must not crash boot
        logger.warning("push.fcm_init_failed", error=str(e))
        return NullPushSender()
