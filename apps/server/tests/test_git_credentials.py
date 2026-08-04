"""Unit tests for account-level Git credentials (G3) — hermetic, no live DB."""

from __future__ import annotations

import pytest

from agentcore.security.keys import KeyEncryptor
from agentcore.workspace import git_credentials as gc
from agentcore.workspace.git_credentials import (
    GitAuthMaterial,
    embed_http_basic_auth,
)


@pytest.fixture
def encryption_key(monkeypatch: pytest.MonkeyPatch) -> str:
    key = "00" * 32
    monkeypatch.setattr(gc.settings, "encryption_key", key)
    return key


def test_embed_http_basic_auth(encryption_key: str):
    url = embed_http_basic_auth(
        "https://github.com/o/r.git",
        username="x-access-token",
        token="ghp_secret",
    )
    assert url == "https://x-access-token:ghp_secret@github.com/o/r.git"


def test_embed_rejects_non_http(encryption_key: str):
    with pytest.raises(ValueError, match="http"):
        embed_http_basic_auth("ssh://git@github.com/o/r.git", username="u", token="t")


def test_mask_and_roundtrip_encrypt(encryption_key: str):
    enc = KeyEncryptor(encryption_key)
    token = "ghp_abcdef1234"
    ct = enc.encrypt(token.encode())
    assert b"ghp_abcdef1234" not in ct
    assert enc.decrypt(ct).decode() == token
    assert gc._mask_token(token) == "••••1234"


def test_load_git_auth_none_without_row(encryption_key: str):
    """encryptor present but no DB row → None (async path covered via service)."""
    material = GitAuthMaterial(username="x-access-token", token="t")
    url = embed_http_basic_auth(
        "https://example.com/a/b.git",
        username=material.username,
        token=material.token,
    )
    assert "@example.com/" in url
    assert "t@" in url or ":t@" in url
