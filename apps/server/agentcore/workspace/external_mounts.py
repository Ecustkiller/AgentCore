"""Session-level read-only external directory mounts (W3).

Model-facing paths use the relative namespace ``external/<alias>/…`` — absolute
OS paths never enter prompts. File tools route through these mounts; write ops
are rejected. ``resolve_safe_path`` / pathGuard algorithms are unchanged: each
mount is a separate root passed into the same guard.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

EXTERNAL_PREFIX = "external/"
_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_READONLY_MSG = "会话授权目录为只读，不能写入；请把产出写到对话工作区"


@dataclass(frozen=True)
class ExternalMount:
    """One session-scoped read-only directory grant.

    ``root_id`` is the desktop authorized-root handle (LocalWorkspace channel).
    ``abs_path`` is set only where the engine has direct Path I/O (sidecar);
    cloud LocalWorkspace leaves it ``None`` and lets the desktop resolve.
    """

    alias: str
    root_id: str
    label: str
    abs_path: str | None = None
    readonly: bool = True


@dataclass(frozen=True)
class RoutedExternal:
    mount: ExternalMount
    """Path relative to the mount root (``""`` / ``"."`` = mount root itself)."""
    rel: str


def sanitize_alias(raw: str) -> str:
    """Derive a stable alias from a folder display name."""
    s = (raw or "").strip().replace("\\", "/").rstrip("/")
    if "/" in s:
        s = s.rsplit("/", 1)[-1]
    s = re.sub(r"[^\w.-]+", "_", s, flags=re.UNICODE).strip("._-")
    if not s:
        s = "folder"
    if s[0].isdigit():
        s = f"d_{s}"
    return s[:64]


def uniquify_alias(base: str, taken: set[str]) -> str:
    """Ensure ``base`` is unique within ``taken`` (append ``_2``, ``_3``, …)."""
    alias = sanitize_alias(base)
    if alias not in taken:
        return alias
    n = 2
    while f"{alias}_{n}" in taken:
        n += 1
    return f"{alias}_{n}"


def parse_external_path(path: str) -> tuple[str, str] | None:
    """If ``path`` is under ``external/<alias>/…``, return ``(alias, rel)``.

    ``rel`` is ``""`` when the path names the mount root itself.
    """
    raw = (path or "").strip().replace("\\", "/").lstrip("/")
    if not raw.startswith(EXTERNAL_PREFIX):
        return None
    rest = raw[len(EXTERNAL_PREFIX) :]
    if not rest:
        return None
    alias, _, rel = rest.partition("/")
    if not alias or not _ALIAS_RE.match(alias):
        return None
    return alias, rel


def route_external(
    path: str, mounts: dict[str, ExternalMount]
) -> RoutedExternal | None:
    """Route an ``external/<alias>/…`` path, or ``None`` when not external."""
    parsed = parse_external_path(path)
    if parsed is None:
        return None
    alias, rel = parsed
    mount = mounts.get(alias)
    if mount is None:
        return None
    return RoutedExternal(mount=mount, rel=rel)


def external_ns(alias: str, rel: str = "") -> str:
    """Build the model-facing path ``external/<alias>[/rel]``."""
    rel = (rel or "").replace("\\", "/").strip("/")
    return f"{EXTERNAL_PREFIX}{alias}/{rel}" if rel else f"{EXTERNAL_PREFIX}{alias}"


def readonly_write_error(path: str) -> str:
    return f"{_READONLY_MSG}（拒绝写入 `{path}`）"


def external_env_var(alias: str) -> str:
    """Env var name for code_execute injection (absolute path value)."""
    safe = re.sub(r"[^A-Za-z0-9]+", "_", alias).strip("_").upper() or "FOLDER"
    return f"AGENTCORE_EXTERNAL_{safe}"


def build_external_env(mounts: dict[str, ExternalMount]) -> dict[str, str]:
    """Map alias → abs path for code_execute env injection (skips missing abs)."""
    out: dict[str, str] = {}
    for alias, m in mounts.items():
        if m.abs_path:
            out[external_env_var(alias)] = m.abs_path
    return out
