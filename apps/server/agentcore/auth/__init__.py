"""Authentication: service, policy, and helpers.

Eager imports here would pull AuthService → MFA → AdminMfaRepository while
``db.repositories.admin_mfa`` is still loading (via ``recovery_codes``), which
breaks schema gate and any ``from agentcore.auth.<submodule>`` entry. Export
lazily so submodule imports stay acyclic.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agentcore.auth.service import AuthService, TokenPair

__all__ = ["AuthService", "TokenPair"]


def __getattr__(name: str) -> Any:
    if name in ("AuthService", "TokenPair"):
        from agentcore.auth.service import AuthService, TokenPair

        return AuthService if name == "AuthService" else TokenPair
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
