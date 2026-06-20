"""Intra-batch write-conflict guard (并行写隔离·硬约束).

A delegate batch runs its sibling workers concurrently against ONE shared workspace
(刻意的共享工作区协作: workers read each other's products). The hole that left open:
two concurrent siblings that pick the SAME output filename both ``file_write`` it and
the later write silently clobbers the earlier — a whole deliverable lost, with only a
prompt hint ("各自用不同文件名") standing in the way.

This is the *hard* backstop for that hint: a per-batch registry of which run "owns"
(last legitimately wrote) each path. A ``file_write`` to a path another run in the same
batch already wrote is refused UNLESS the writer transitively depends on that owner —
i.e. a real upstream→downstream handoff (a downstream consolidating an upstream's file
is intended), never two unrelated siblings. The refusal is a guiding error the worker
acts on (rename with a distinct suffix), so the collision becomes loud instead of a
silent data loss. The shared-workspace model is untouched: any worker may still
``file_read`` any peer's file — only blind concurrent OVERWRITE is blocked.

Scope is the batch, not the turn: only siblings in ONE ``WaveScheduler`` run are truly
concurrent (the CEO awaits each ``delegate`` before the next; a nested sub-team runs
while its captain is suspended inside the delegate call). So each ``build_agent_executor``
owns one coordinator, and a later CEO-directed batch overwriting an earlier batch's file
(a conscious refinement) is correctly NOT blocked. Single-threaded asyncio makes the
check-and-claim atomic: ``claim`` is synchronous and called BEFORE the awaited write, so
two concurrent claims can never interleave.

→ 见设计: docs/03-AI核心/编排器与CEO主Agent.md §2.3（并行写隔离：软提示 + 硬守卫）
"""

from __future__ import annotations

from posixpath import normpath


def _normalize(path: str) -> str:
    """Canonical key for a workspace-relative path so ``a/b``, ``./a/b`` and ``a//b``
    collide on one owner. POSIX separators, collapsed, leading slashes stripped; case
    is preserved (the server filesystem is case-sensitive). ``..`` traversal is left to
    the backend's own guard — this only needs a stable key, not a safe path."""
    return normpath(path.strip().replace("\\", "/")).lstrip("/")


class WriteCoordinator:
    """Tracks the owning run of each written path within ONE delegate batch.

    Holds no async state and no lock — every method is synchronous, relying on the
    single-threaded event loop for atomicity (claim before the awaited write). Lives
    only as long as its batch's executor, so claims are naturally scoped and need no
    end-of-run release.
    """

    def __init__(self) -> None:
        # normalized path -> run_id that last legitimately wrote it (this batch only).
        self._owner: dict[str, str] = {}

    def claim(self, path: str, run_id: str, ancestors: frozenset[str]) -> str | None:
        """Try to record ``run_id`` as the writer of ``path``.

        Returns ``None`` when the write may proceed — the path is unclaimed, already
        owned by ``run_id`` (rewriting its own file, e.g. a contract retry), or owned by
        one of ``ancestors`` (a dependency whose product this run consolidates) — and
        transfers ownership to ``run_id``. Returns the conflicting owner's run_id
        (leaving ownership untouched) when an unrelated concurrent sibling already wrote
        it; the caller turns that into a guiding "pick a distinct name" error.
        """
        key = _normalize(path)
        owner = self._owner.get(key)
        if owner is not None and owner != run_id and owner not in ancestors:
            return owner
        self._owner[key] = run_id
        return None

    def release(self, path: str, run_id: str) -> None:
        """Drop ``run_id``'s ownership of ``path`` (only if it still holds it).

        Called when a claimed write then FAILS, so a path the run never actually created
        doesn't spuriously block a sibling for the rest of the batch.
        """
        key = _normalize(path)
        if self._owner.get(key) == run_id:
            del self._owner[key]
