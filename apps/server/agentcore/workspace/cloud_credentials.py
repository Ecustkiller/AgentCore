"""Sidecar workspaces narrow-ticket credentials (ContextVar).

Desktop injects ``workspacesAuth: {baseUrl, apiKey}`` shaped like folders /
account. ``baseUrl`` is ``…/v1/workspaces``; ``apiKey`` is the
``type=workspaces`` JWT from ``POST /v1/workspaces/token``. Cloud API processes
never bind the ContextVar — they keep on-disk ``ServerWorkspace``.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass

_workspaces_creds: ContextVar[WorkspacesCredentials | None] = ContextVar(
    "workspaces_cloud_creds", default=None
)


@dataclass(frozen=True)
class WorkspacesCredentials:
    """Minimal auth for cloud ``/v1/workspaces/{id}/files*`` (leaf-owned)."""

    api_key: str
    base_url: str


def get_workspaces_credentials() -> WorkspacesCredentials | None:
    return _workspaces_creds.get()


@contextmanager
def workspaces_credentials_scope(
    creds: WorkspacesCredentials | None,
) -> Iterator[None]:
    token: Token[WorkspacesCredentials | None] = _workspaces_creds.set(creds)
    try:
        yield
    finally:
        _workspaces_creds.reset(token)
