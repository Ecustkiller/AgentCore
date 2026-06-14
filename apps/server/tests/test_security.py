"""Unit tests for security primitives (pure functions, no DB)."""

from datetime import timedelta

import pytest

from agentcore.core.errors import AuthenticationError
from agentcore.security import (
    create_access_token,
    decode_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)

# --- passwords ---


def test_hash_password_then_verify():
    h = hash_password("s3cret-pw")
    assert h != "s3cret-pw"
    assert verify_password("s3cret-pw", h) is True


def test_verify_password_rejects_wrong():
    h = hash_password("s3cret-pw")
    assert verify_password("nope", h) is False


def test_hash_password_is_salted():
    # Same input must yield different hashes (random per-hash salt).
    assert hash_password("same-input") != hash_password("same-input")


# --- access tokens ---


def test_access_token_roundtrip():
    token = create_access_token("user-123")
    assert decode_access_token(token) == "user-123"


def test_access_token_expired_is_rejected():
    token = create_access_token("user-123", expires_delta=timedelta(seconds=-1))
    with pytest.raises(AuthenticationError):
        decode_access_token(token)


def test_access_token_tampered_signature_is_rejected():
    token = create_access_token("user-123")
    header, payload, sig = token.split(".")
    flipped = ("B" if sig[0] != "B" else "C") + sig[1:]
    with pytest.raises(AuthenticationError):
        decode_access_token(f"{header}.{payload}.{flipped}")


def test_decode_garbage_is_rejected():
    with pytest.raises(AuthenticationError):
        decode_access_token("not.a.valid.jwt")


# --- refresh tokens ---


def test_generate_refresh_token_returns_raw_and_matching_hash():
    raw, token_hash = generate_refresh_token()
    assert raw and token_hash
    assert raw != token_hash
    assert hash_refresh_token(raw) == token_hash


def test_refresh_tokens_are_unique():
    raw1, _ = generate_refresh_token()
    raw2, _ = generate_refresh_token()
    assert raw1 != raw2
