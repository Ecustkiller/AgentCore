"""Admin MFA recovery-code hashing (argon2id) + legacy SHA-256 verify."""

from __future__ import annotations

import hashlib
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
    """True iff ``code`` matches a stored hash (argon2id or legacy bare SHA-256)."""
    if not stored:
        return False
    if stored.startswith("$argon2"):
        return verify_password(code, stored)
    # Legacy: unsalted SHA-256 hex digest (pre-P1). Accept until re-enrollment.
    if len(stored) == 64 and all(c in "0123456789abcdef" for c in stored):
        digest = hashlib.sha256(code.encode()).hexdigest()
        return secrets.compare_digest(digest, stored)
    return False
