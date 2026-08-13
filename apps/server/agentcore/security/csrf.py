"""Stateless HMAC-signed CSRF tokens for cookie-session clients."""

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime
from enum import StrEnum
from functools import lru_cache

from agentcore.config import settings

# Cookie-session clients (admin console, desktop) echo this token in an
# ``X-CSRF-Token`` header on mutating requests. It is STATELESS by design: the
# signature is recomputed from the request's authenticated ``user_id`` at verify
# time, so there is no server-side store. This matches the stateless JWT access
# cookie it rides alongside — a server-stored synchronizer token would be orphaned
# on every restart/reload and across workers, 403-ing an otherwise-valid session.
# The token carries no secret (nonce + expiry + signature); an attacker's
# cross-origin page can neither read it (CORS) nor forge it (no signing key) — which
# is exactly the CSRF guarantee. Wire format: ``v1.<nonce>.<exp>.<sig>``.

_CSRF_TOKEN_VERSION = "v1"
_CSRF_KEY_INFO = b"agentcore.csrf.v1"


class CsrfRejectReason(StrEnum):
    """Why a presented token was refused — the ``reason`` on ``security.csrf_rejected``.

    Four values rather than missing/invalid: "the client never had a token"
    (:attr:`MISSING`), "the token aged out" (:attr:`EXPIRED`) and "the token was
    signed for another session or under another key" (:attr:`SIGNATURE_MISMATCH`)
    are three different faults with three different fixes, and collapsing them
    left the production rejections unattributable.
    """

    MISSING = "missing"
    MALFORMED = "malformed"
    EXPIRED = "expired"
    SIGNATURE_MISMATCH = "signature_mismatch"


@lru_cache(maxsize=2)
def _derive_signing_key(jwt_secret: str) -> bytes:
    """Derive a dedicated CSRF signing key from the JWT secret (domain separation,
    so one secret never directly signs two distinct token formats).

    Memoised on the secret itself rather than globally, so a rotated (or
    monkeypatched) value is never served a stale key.
    """
    return hmac.new(jwt_secret.encode("utf-8"), _CSRF_KEY_INFO, hashlib.sha256).digest()


def _csrf_sign(message: str) -> str:
    key = _derive_signing_key(settings.jwt_secret_key)
    digest = hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def sign_csrf_token(user_id: str, *, ttl_seconds: int | None = None) -> str:
    """Mint a stateless, HMAC-signed CSRF token bound to ``user_id``.

    The lifetime defaults to the refresh-token window because that is the session's
    own outer bound: the token is only re-issued when the session is opened or
    renewed (``middleware.csrf``), so anything shorter would expire under a client
    that is idle but still logged in. An aged-out token costs one 403, which
    re-arms the client.
    """
    ttl = (
        ttl_seconds
        if ttl_seconds is not None
        else settings.jwt_refresh_token_expire_days * 86400
    )
    nonce = secrets.token_urlsafe(16)
    exp = int(datetime.now(UTC).timestamp()) + ttl
    sig = _csrf_sign(f"{_CSRF_TOKEN_VERSION}.{user_id}.{nonce}.{exp}")
    return f"{_CSRF_TOKEN_VERSION}.{nonce}.{exp}.{sig}"


def csrf_reject_reason(user_id: str, token: str) -> CsrfRejectReason | None:
    """Return why ``token`` is unacceptable for ``user_id``, or ``None`` if it is valid.

    Constant-time signature check, no server state. ``user_id`` comes from the
    verified access-token cookie, which binds the token to that session (another
    user's token recomputes to a different signature and fails).

    The signature is checked *before* the expiry so the reported reason is
    attributable: only a token we really minted for this session can be reported as
    :attr:`~CsrfRejectReason.EXPIRED`, and anything forged, tampered with, or bound
    to a different session lands on :attr:`~CsrfRejectReason.SIGNATURE_MISMATCH`.
    """
    if not token:
        return CsrfRejectReason.MISSING
    parts = token.split(".")
    if len(parts) != 4:
        return CsrfRejectReason.MALFORMED
    version, nonce, exp_raw, sig = parts
    if version != _CSRF_TOKEN_VERSION:
        return CsrfRejectReason.MALFORMED
    try:
        exp = int(exp_raw)
    except ValueError:
        return CsrfRejectReason.MALFORMED
    expected = _csrf_sign(f"{version}.{user_id}.{nonce}.{exp}")
    if not hmac.compare_digest(expected, sig):
        return CsrfRejectReason.SIGNATURE_MISMATCH
    if exp < int(datetime.now(UTC).timestamp()):
        return CsrfRejectReason.EXPIRED
    return None


def verify_csrf_token(user_id: str, token: str) -> bool:
    """Return True iff ``token`` is a valid, unexpired CSRF token for ``user_id``."""
    return csrf_reject_reason(user_id, token) is None
