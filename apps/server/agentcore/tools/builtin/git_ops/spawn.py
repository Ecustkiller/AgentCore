"""Account PAT helper for a cloud ``run`` of ``git`` / ``gh``.

Local workspaces inherit the OS credential helper and look nothing up.
The token is passed as a git credential-helper env, never as a tool argument.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger
from agentcore.tools.protocol import ToolContext

if TYPE_CHECKING:
    from agentcore.workspace.git_credentials import GitAuthMaterial

logger = get_logger(__name__)

_GIT_CREDENTIAL_TIMEOUT = 10.0


def _is_cloud_backend(context: ToolContext) -> bool:
    """Cloud ServerWorkspace only — Local inherits OS / gh auth."""
    return getattr(context.backend, "location", None) == "server"


async def _load_account_git_auth(
    user_id: str, *, timeout: float = _GIT_CREDENTIAL_TIMEOUT
) -> GitAuthMaterial | None:
    """Bounded, fail-soft account PAT lookup.

    A timeout is treated as "no PAT configured": git runs without injected
    credentials and fails authentication honestly.
    """
    from agentcore.workspace.git_credentials import load_git_auth_for_user

    try:
        return await asyncio.wait_for(load_git_auth_for_user(user_id), timeout)
    except TimeoutError:
        logger.warning(
            "git.credential_lookup_timeout", scope="account_pat", timeout_seconds=timeout
        )
        return None


async def cloud_git_auth_env(context: ToolContext) -> dict[str, str] | None:
    """Env for a cloud ``run`` of ``git`` / ``gh`` (short or background)."""
    if not _is_cloud_backend(context) or not context.user_id:
        return None
    auth = await _load_account_git_auth(context.user_id)
    if auth is None:
        return None
    helper = (
        f'!f() {{ echo "username={auth.username}"; echo "password={auth.token}"; }}; f'
    )
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": helper,
    }
