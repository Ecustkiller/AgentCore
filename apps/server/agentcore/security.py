"""Security primitives: password hashing, JWT access tokens, refresh tokens.

Pure functions with no DB or framework coupling, so they are trivially
unit-testable. Higher layers (auth service, dependencies) compose these.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

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
