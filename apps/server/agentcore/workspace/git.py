"""Clone a public git repository into a conversation's workspace (决策⑤).

The developer half of "文件进出": after upload (anyone), ``git clone`` brings an
existing public repo into the project space. Cloud mode runs ``git`` as a server
subprocess into the resolved workspace root; P2 (local mode) routes the same
operation through the desktop channel — this module is the server-side seam.

Safety:
- ``git`` is invoked via argv (``create_subprocess_exec``) — never a shell
  string — so a hostile URL cannot inject commands.
- Only ``http(s)`` URLs are accepted (public repos; private-repo tokens come
  later). ``ssh``/``file``/etc. are rejected so the server can't be coerced into
  reading local repos or arbitrary hosts via a different transport.
- The clone is shallow + single-branch, has a timeout, and runs with
  ``GIT_TERMINAL_PROMPT=0`` so an auth-required repo fails fast instead of
  hanging on a credential prompt.
- The destination is resolved through the traversal guard, so it can never land
  outside the workspace, and an existing non-empty destination is refused.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse

from agentcore.config import settings
from agentcore.workspace._paths import resolve_safe_path
from agentcore.workspace.locate import resolve_workspace_root

_ALLOWED_SCHEMES = ("http", "https")


class CloneError(Exception):
    """The ``git clone`` subprocess failed (bad URL, missing repo, network, …)."""


def _validate_url(repo_url: str) -> None:
    parsed = urlparse(repo_url.strip())
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise ValueError("Only http(s) repository URLs are supported")
    if not parsed.netloc:
        raise ValueError("Invalid repository URL")


def _derive_dest_name(repo_url: str) -> str:
    """The default target dir: the repo's name (last path segment, minus .git)."""
    path = urlparse(repo_url.strip()).path.rstrip("/")
    name = path.rsplit("/", 1)[-1]
    if name.endswith(".git"):
        name = name[:-4]
    return name or "repo"


async def clone_repo(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    repo_url: str,
    dest: str | None = None,
    depth: int = 1,
) -> str:
    """Clone ``repo_url`` into the conversation's workspace; return the dest path.

    ``dest`` (workspace-relative) defaults to the repo name. Raises ``ValueError``
    for a bad URL / destination, ``CloneError`` if the clone itself fails.
    """
    _validate_url(repo_url)
    root = resolve_workspace_root(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    dest_rel = dest.strip() if dest and dest.strip() else _derive_dest_name(repo_url)
    target = resolve_safe_path(root, dest_rel)
    if target is None:
        raise ValueError("Invalid destination path")
    if target.exists() and any(target.iterdir()):
        raise ValueError("Destination already exists and is not empty")

    await _git_clone(
        repo_url, target, depth=depth, timeout=settings.workspace_clone_timeout_seconds
    )
    # ``target`` is the resolved absolute path from the traversal guard; report it
    # back relative to the (resolved) workspace root for the client.
    return target.relative_to(root.resolve()).as_posix()


async def _git_clone(repo_url: str, dest: Path, *, depth: int, timeout: int) -> None:
    """Run ``git clone`` into ``dest`` via argv (no shell); raise on failure.

    Separated from :func:`clone_repo` (which owns URL policy) so the raw mechanics
    can be tested hermetically against a local ``file://`` source repo.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    args = ["git", "clone", "--single-branch"]
    if depth and depth > 0:
        args += ["--depth", str(depth)]
    args += [repo_url, str(dest)]

    # Never prompt for credentials: a private/auth-required repo should fail fast,
    # not hang the request waiting on stdin that will never come.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}

    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except OSError as e:  # git not installed / not on PATH
        raise CloneError(f"could not start git: {e}") from e

    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise CloneError(f"git clone timed out after {timeout}s") from None

    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() or "git clone failed"
        raise CloneError(detail)
