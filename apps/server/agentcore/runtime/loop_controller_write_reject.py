"""Write-reject streak strategy (same-path force_segmented early path).

Split from ``loop_controller`` — pure move. Consumed only as a mixin by
:class:`~agentcore.runtime.loop_controller.LoopController`.
"""

from __future__ import annotations

from agentcore.runtime.loop_controller_types import (
    PATH_SEGMENT_FORCE_TOOLS,
    ToolAttempt,
    _norm_write_reject_path,
    classify_segmented_write_reject,
)


class WriteRejectStreakMixin:
    """Same-path consecutive classified write rejects → force_segmented latch."""

    # Declared on LoopController.__init__; listed for type-checkers.
    _path_write_rejects: dict[str, tuple[str, int]]
    _path_write_reject_streak: int
    _tool_segmented_forced: set[str]
    _tool_disabled: set[str]
    _pending_path_force_segmented: bool

    def _note_path_write_reject(self, attempt: ToolAttempt) -> None:
        """Bump / reset same-path classified write-reject streak for force_segmented."""
        path = _norm_write_reject_path((attempt.meta or {}).get("path"))
        if not path or attempt.tool_name not in PATH_SEGMENT_FORCE_TOOLS:
            return
        if attempt.success:
            self._path_write_rejects.pop(path, None)
            return
        if attempt.policy_failure:
            return
        reject_class = (attempt.meta or {}).get("segmented_write_reject")
        if not isinstance(reject_class, str) or not reject_class.strip():
            reject_class = classify_segmented_write_reject(
                attempt.tool_name,
                error=attempt.error_summary or "",
                contract_failure=bool(attempt.contract_failure),
            )
        else:
            reject_class = reject_class.strip()
        if not reject_class:
            # Other write failure on this path breaks the classified streak.
            self._path_write_rejects.pop(path, None)
            return
        prev = self._path_write_rejects.get(path)
        streak = (
            prev[1] + 1 if prev is not None and prev[0] == reject_class else 1
        )
        self._path_write_rejects[path] = (reject_class, streak)
        if streak >= self._path_write_reject_streak and not (
            self._tool_segmented_forced >= PATH_SEGMENT_FORCE_TOOLS
        ):
            self._pending_path_force_segmented = True
