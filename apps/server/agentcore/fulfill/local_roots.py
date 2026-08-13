"""Engine-side declaration of the local FS roots this process must fulfil against.

Cloud: engine and fulfiller sit on different machines, and the API process already
binds each root to the device that registered it (:mod:`agentcore.fulfill.declare`).
No declarer is installed there, so every call here is a no-op.

Sidecar (本机引擎): the engine runs inside a process the desktop spawned and its
own :class:`~agentcore.sidecar.fulfill_bridge.SidecarFulfillBridge` is the only
session on the in-process hub. Nobody outside can tell that hub about a root the
engine first learns mid-turn — a cross-desk worker resolves its root from the
*target* folder's binding, not from the turn's ``localRootId`` — so the workspace
composition root calls :func:`declare_local_root` and the bridge widens its
declared set right there, before the desk issues its first op.

Only roots this process actually built a workspace for are declared: a root is an
authorization boundary, so 「把已知的根一股脑声明上去」 is a different (and wrong)
thing. Execution stays gated by the desktop's own grant store either way.
"""

from __future__ import annotations

from typing import Protocol


class LocalRootDeclarer(Protocol):
    """The fulfiller-side sink for a root this engine is about to use."""

    def declare_root(self, root_id: str) -> None: ...


_declarer: LocalRootDeclarer | None = None


def install_local_root_declarer(declarer: LocalRootDeclarer) -> None:
    """Route later :func:`declare_local_root` calls to this process's fulfiller."""
    global _declarer
    _declarer = declarer


def uninstall_local_root_declarer(declarer: LocalRootDeclarer) -> None:
    """Detach ``declarer``.

    Identity-checked so a rebind that closed the previous session cannot clear
    the successor that was installed in its place.
    """
    global _declarer
    if _declarer is declarer:
        _declarer = None


def declare_local_root(root_id: str) -> None:
    """Declare ``root_id`` on the in-process fulfiller (no-op without one)."""
    rid = (root_id or "").strip()
    declarer = _declarer
    if not rid or declarer is None:
        return
    declarer.declare_root(rid)
