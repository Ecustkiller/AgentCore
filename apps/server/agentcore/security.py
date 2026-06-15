"""Security primitives: password hashing, JWT access tokens, refresh tokens,
at-rest secret encryption (BYOK API keys).

Pure functions / DB-free primitives with no framework coupling, so they are
trivially unit-testable. Higher layers (auth service, dependencies, the BYOK
key service) compose these.
"""

import hashlib
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


def create_access_token(
    user_id: str, *, expires_delta: timedelta | None = None
) -> str:
    """Mint a short-lived access JWT carrying ``user_id`` as the subject."""
    now = datetime.now(UTC)
    expire = now + (
        expires_delta
        or timedelta(minutes=settings.jwt_access_token_expire_minutes)
    )
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
        claims = jwt.decode(
            token, settings.jwt_secret_key, algorithms=[_JWT_ALGORITHM]
        )
    except JWTError as exc:
        raise AuthenticationError("Invalid or expired token") from exc

    if claims.get("type") != "access":
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


# --- Invite codes (shareable, single-use registration tokens) ---


def generate_invite_code() -> str:
    """Return a high-entropy, URL-safe invite code for admin-issued invites."""
    return secrets.token_urlsafe(12)


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
