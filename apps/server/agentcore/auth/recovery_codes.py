"""Admin MFA recovery-code hashing (argon2id only)."""

from __future__ import annotations

import secrets

from agentcore.security.passwords import hash_password, verify_password

# 8 bytes → 16 hex chars (fits auth schema max_length=16).
RECOVERY_CODE_BYTES = 8
RECOVERY_CODE_COUNT = 8


def generate_recovery_codes(n: int = RECOVERY_CODE_COUNT) -> list[str]:
    return [secrets.token_hex(RECOVERY_CODE_BYTES) for _ in range(n)]


def hash_recovery_code(code: str) -> str:
    """Hash a normalized recovery code for storage (argon2id, salt embedded)."""
    return hash_password(code)


def recovery_code_matches(code: str, stored: str) -> bool:
    """True iff ``code`` matches a stored argon2id hash."""
    if not stored or not stored.startswith("$argon2"):
        return False
    return verify_password(code, stored)
