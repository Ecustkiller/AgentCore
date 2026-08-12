"""Absolute-path predicate that must not follow the *server's* OS (zero project deps).

The API runs on Linux while its desktop clients run Windows and macOS, so
``os.path.isabs`` answers the wrong question for any path that crossed the wire:
``D:\\资料`` is absolute to the client that sent it and merely relative to the Linux
host inspecting it. Wire-facing absolute checks go through here so the verdict
belongs to the client rather than to whichever runner executes the code — that
divergence is also why a Windows dev machine and Linux CI can disagree about the
very same payload.
"""

from __future__ import annotations

from pathlib import PureWindowsPath

__all__ = ["is_absolute_os_path"]


def is_absolute_os_path(raw: str) -> bool:
    """True for drive-letter / UNC / leading-slash absolute OS paths, on any host."""
    s = raw.strip()
    if not s:
        return False
    if PureWindowsPath(s).is_absolute():
        return True
    return s.replace("\\", "/").startswith("/")
