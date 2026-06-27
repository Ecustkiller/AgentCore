"""JWT access and inference tokens (python-jose)."""

from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt

from agentcore.config import settings
from agentcore.core.errors import AuthenticationError

_JWT_ALGORITHM = "HS256"


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


def create_inference_token(user_id: str, *, expires_delta: timedelta | None = None) -> str:
    """Mint a scoped token authorizing a local sidecar's LLM calls through the cloud
    inference proxy (双模式工作区 §一.1 / Slice 4a).

    The desktop authenticates via httpOnly cookies, so the renderer can never hand
    the sidecar a usable bearer; instead it exchanges its cookie for THIS token and
    passes it to the on-machine engine, which sends it as ``Authorization: Bearer``
    to ``/v1/inference``. A distinct ``type`` ("inference", not "access") means it
    can ONLY authorize the inference proxy — :func:`decode_inference_token` refuses
    an access token and :func:`decode_access_token` refuses this one, so the two kinds
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
