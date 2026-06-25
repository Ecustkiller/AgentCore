"""Security primitives: password hashing, JWT access tokens, refresh tokens,
at-rest secret encryption (BYOK API keys).

Pure functions / DB-free primitives with no framework coupling, so they are
trivially unit-testable. Higher layers (auth service, dependencies, the BYOK
key service) compose these.
"""

import base64
import hashlib
import hmac
import os
import secrets
from binascii import unhexlify
from datetime import UTC, datetime, timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from jose import JWTError, jwt
from pwdlib import PasswordHash

from agentcore.config import settings
from agentcore.core.errors import AuthenticationError

_JWT_ALGORITHM = "HS256"

# argon2id via pwdlib[argon2]; per-hash salt is embedded in the output string.
_password_hasher = PasswordHash.recommended()


# --- Passwords ---


def hash_password(password: str) -> str:
    """Hash a plaintext password (argon2id). Output embeds salt + parameters."""
    return _password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Return True iff ``password`` matches the stored hash."""
    return _password_hasher.verify(password, password_hash)


# --- Access tokens (stateless JWT) ---


def create_access_token(user_id: str, *, expires_delta: timedelta | None = None) -> str:
    """Mint a short-lived access JWT carrying ``user_id`` as the subject."""
    now = datetime.now(UTC)
    expire = now + (expires_delta or timedelta(minutes=settings.jwt_access_token_expire_minutes))
    claims = {
        "sub": user_id,
        "type": "access",
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }
    return jwt.encode(claims, settings.jwt_secret_key, algorithm=_JWT_ALGORITHM)


def decode_access_token(token: str) -> str:
    """Return the subject (user_id) of a valid access token.

    Raises ``AuthenticationError`` for any invalid, tampered, expired, or
    wrong-type token so callers can translate it to a 401 uniformly.
    """
    try:
        claims = jwt.decode(token, settings.jwt_secret_key, algorithms=[_JWT_ALGORITHM])
    except JWTError as exc:
        raise AuthenticationError("Invalid or expired token") from exc

    if claims.get("type") != "access":
        raise AuthenticationError("Wrong token type")
    sub = claims.get("sub")
    if not sub:
        raise AuthenticationError("Token missing subject")
    return sub


# --- Inference tokens (scoped JWT for the sidecar's cloud-proxy LLM calls) ---


def create_inference_token(user_id: str, *, expires_delta: timedelta | None = None) -> str:
    """Mint a scoped token authorizing a local sidecar's LLM calls through the cloud
    inference proxy (双模式工作区 §一.1 / Slice 4a).

    The desktop authenticates via httpOnly cookies, so the renderer can never hand
    the sidecar a usable bearer; instead it exchanges its cookie for THIS token and
    passes it to the on-machine engine, which sends it as ``Authorization: Bearer``
    to ``/v1/inference``. A distinct ``type`` ("inference", not "access") means it
    can ONLY authorize the inference proxy — :func:`decode_inference_token` refuses
    an access token and ``decode_access_token`` refuses this one, so the two kinds
    can never be confused (a leaked inference token can't drive the cookie-auth API).
    """
    now = datetime.now(UTC)
    expire = now + (expires_delta or timedelta(minutes=settings.inference_token_expire_minutes))
    claims = {
        "sub": user_id,
        "type": "inference",
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
    }
    return jwt.encode(claims, settings.jwt_secret_key, algorithm=_JWT_ALGORITHM)


def decode_inference_token(token: str) -> str:
    """Return the subject (user_id) of a valid inference token (Slice 4a).

    Raises ``AuthenticationError`` for any invalid, tampered, expired, or
    wrong-type token (including a regular ``access`` token), so the proxy
    translates it to a 401 uniformly.
    """
    try:
        claims = jwt.decode(token, settings.jwt_secret_key, algorithms=[_JWT_ALGORITHM])
    except JWTError as exc:
        raise AuthenticationError("Invalid or expired inference token") from exc

    if claims.get("type") != "inference":
        raise AuthenticationError("Wrong token type")
    sub = claims.get("sub")
    if not sub:
        raise AuthenticationError("Token missing subject")
    return sub


# --- Refresh tokens (opaque, high-entropy) ---


def hash_refresh_token(raw: str) -> str:
    """Hash a refresh token for storage.

    Refresh tokens are high-entropy random strings (not user-chosen secrets),
    so a fast cryptographic digest is sufficient and avoids a slow KDF on the
    hot refresh path. Only the hash is ever persisted.
    """
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def generate_refresh_token() -> tuple[str, str]:
    """Return ``(raw, hash)``: send ``raw`` to the client, persist ``hash``."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


# --- CSRF tokens (stateless, HMAC-signed) ---
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


def _csrf_signing_key() -> bytes:
    """Derive a dedicated CSRF signing key from the JWT secret (domain separation,
    so one secret never directly signs two distinct token formats)."""
    return hmac.new(
        settings.jwt_secret_key.encode("utf-8"), _CSRF_KEY_INFO, hashlib.sha256
    ).digest()


def _csrf_sign(message: str) -> str:
    digest = hmac.new(_csrf_signing_key(), message.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def sign_csrf_token(user_id: str, *, ttl_seconds: int | None = None) -> str:
    """Mint a stateless, HMAC-signed CSRF token bound to ``user_id``.

    The lifetime defaults to the refresh-token window; since every login/refresh
    re-issues a token long before then, expiry is never the binding constraint in a
    live session.
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


def verify_csrf_token(user_id: str, token: str) -> bool:
    """Return True iff ``token`` is a valid, unexpired CSRF token for ``user_id``.

    Constant-time signature check, no server state. ``user_id`` comes from the
    verified access-token cookie, which binds the token to that session (another
    user's token recomputes to a different signature and fails).
    """
    parts = token.split(".")
    if len(parts) != 4:
        return False
    version, nonce, exp_raw, sig = parts
    if version != _CSRF_TOKEN_VERSION:
        return False
    try:
        exp = int(exp_raw)
    except ValueError:
        return False
    if exp < int(datetime.now(UTC).timestamp()):
        return False
    expected = _csrf_sign(f"{version}.{user_id}.{nonce}.{exp}")
    return hmac.compare_digest(expected, sig)


# --- Invite codes (shareable, single-use registration tokens) ---


def generate_invite_code() -> str:
    """Return a high-entropy, URL-safe invite code for admin-issued invites."""
    return secrets.token_urlsafe(12)


# A one-off password handed to a user after an admin reset. Readable (drops the
# ambiguous 0/O/1/l/I) and long enough to clear the registration policy (≥8) with
# margin, so it survives being copied out of the console and typed back in.
_TEMP_PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_TEMP_PASSWORD_LENGTH = 14


def generate_temp_password() -> str:
    """Return a high-entropy, human-readable one-off password (admin reset)."""
    return "".join(secrets.choice(_TEMP_PASSWORD_ALPHABET) for _ in range(_TEMP_PASSWORD_LENGTH))


# --- Symmetric encryption (at-rest secrets: BYOK provider keys) ---
# AES-256-GCM for encrypting user-supplied API keys before they touch the DB
# (db/models.py UserLlmKey.api_key_enc). The plaintext key never lands on disk;
# the 32-byte master key comes from settings.encryption_key (64 hex chars) and
# lives only in server config. Wire format: nonce(12B) ‖ ciphertext+tag.


class KeyEncryptor:
    """AES-256-GCM encryptor for at-rest secrets (BYOK API keys).

    Constructed from a 64-hex-char (32-byte) master key so it stays a pure,
    DB-free primitive (the caller reads ``settings.encryption_key``). Raises
    ``ValueError`` on a malformed key, so a misconfigured server fails loudly
    rather than silently storing unreadable ciphertext.
    """

    _NONCE_SIZE = 12

    def __init__(self, hex_key: str) -> None:
        raw = unhexlify(hex_key)
        if len(raw) != 32:
            raise ValueError(
                f"encryption_key must be 32 bytes (64 hex chars), got {len(raw)} bytes"
            )
        self._gcm = AESGCM(raw)

    def encrypt(self, plaintext: bytes) -> bytes:
        """Return ``nonce ‖ ciphertext+tag`` (a fresh random nonce each call)."""
        nonce = os.urandom(self._NONCE_SIZE)
        return nonce + self._gcm.encrypt(nonce, plaintext, None)

    def decrypt(self, ciphertext: bytes) -> bytes:
        """Inverse of :meth:`encrypt`; raises on a too-short or tampered input."""
        if len(ciphertext) < self._NONCE_SIZE:
            raise ValueError("ciphertext too short")
        nonce = ciphertext[: self._NONCE_SIZE]
        return self._gcm.decrypt(nonce, ciphertext[self._NONCE_SIZE :], None)
