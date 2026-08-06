"""Recovery code hashing: argon2id only (legacy SHA-256 rejected)."""

from __future__ import annotations

import hashlib

from agentcore.auth.recovery_codes import (
    RECOVERY_CODE_BYTES,
    generate_recovery_codes,
    hash_recovery_code,
    recovery_code_matches,
)


def test_generate_recovery_codes_entropy_and_count():
    codes = generate_recovery_codes()
    assert len(codes) == 8
    assert len({c for c in codes}) == 8
    for c in codes:
        assert len(c) == RECOVERY_CODE_BYTES * 2
        assert all(ch in "0123456789abcdef" for ch in c)


def test_hash_recovery_code_is_argon2():
    h = hash_recovery_code("aabbccddeeff0011")
    assert h.startswith("$argon2")
    assert recovery_code_matches("aabbccddeeff0011", h)
    assert not recovery_code_matches("aabbccddeeff0012", h)


def test_legacy_sha256_recovery_no_longer_matches():
    code = "deadbeef"
    legacy = hashlib.sha256(code.encode()).hexdigest()
    assert not recovery_code_matches(code, legacy)
    assert not recovery_code_matches("cafebabe", legacy)
