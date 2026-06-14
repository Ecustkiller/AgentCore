"""Convergence governance: deterministic stuck detection + graded intervention.

This runs *outside* the model — no extra LLM calls — between ReAct rounds. It
catches the three canonical mechanical loop patterns that a model does not
recognize about itself, over a sliding window of recent tool attempts:

  * repeated identical tool call  — same tool + same normalized args
  * A-B-A-B alternation           — oscillating between two calls
  * repeated identical failure    — same tool failing the same way

When a pattern trips, the controller recommends a *graded* intervention: first a
nudge (a reflection message anchored to the concrete detected fact, never
open-ended self-doubt), then a hard finalize (force a tool-free answer).

Design grounding (see 规划/收敛治理-loop_controller.md): hard round caps are a
tripwire, not a convergence mechanism; detection must be enforced in code, not
via prompt; and an injected reflection must be anchored to an external signal
(the observed repetition) or it diverges into self-flagellation / sycophancy.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter, deque
from dataclasses import dataclass
from enum import StrEnum

DEFAULT_WINDOW = 8
DEFAULT_THRESHOLD = 3


class StuckReason(StrEnum):
    """Which mechanical loop pattern was observed."""

    REPEATED_CALL = "repeated_call"
    ALTERNATING = "alternating"
    REPEATED_FAILURE = "repeated_failure"


class Intervention(StrEnum):
    """What the engine should do this round."""

    CONTINUE = "continue"
    NUDGE = "nudge"
    FINALIZE = "finalize"


@dataclass(frozen=True)
class ToolAttempt:
    """One executed tool call in a round; ``success`` carries the failure signal."""

    fingerprint: str
    tool_name: str
    success: bool


@dataclass(frozen=True)
class StuckSignal:
    """A detected stuck pattern plus the facts needed to anchor a nudge."""

    reason: StuckReason
    tool_name: str
    count: int

    def reflection_message(self) -> str:
        """Steer message anchored to the concrete observation.

        Anchoring to the real fact ("you called X 3 times") rather than a vague
        "think harder" is what keeps the injected reflection from diverging.
        """
        if self.reason is StuckReason.REPEATED_FAILURE:
            return (
                f"[系统提示] 工具 `{self.tool_name}` 已用相同方式失败 {self.count} 次，"
                "继续重试只会再次失败。请不要再以相同参数调用它："
                "改用不同的输入、换一个工具，或基于已有信息直接给出最终答案。"
            )
        if self.reason is StuckReason.ALTERNATING:
            return (
                f"[系统提示] 你在两个动作之间来回循环（其中之一是 `{self.tool_name}`）"
                "却没有取得进展。请跳出循环：选定一个能真正推进到答案的具体下一步，"
                "或现在就给出最终答案。"
            )
        return (
            f"[系统提示] 你已用相同参数调用 `{self.tool_name}` {self.count} 次，"
            "没有任何新进展。请停止重复：要么换一种实质不同的做法或参数，"
            "要么基于现有信息直接给出最终答案。"
        )


def fingerprint_tool_call(name: str, arguments: str) -> str:
    """Stable hash of ``(tool_name, normalized args)``.

    Args are normalized via key-sorted JSON so semantically identical calls map
    to one fingerprint; malformed JSON falls back to the raw argument string so
    verbatim repeats are still caught.
    """
    try:
        parsed = json.loads(arguments) if arguments else {}
        normalized = json.dumps(
            parsed, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        )
    except (json.JSONDecodeError, TypeError):
        normalized = arguments or ""
    return hashlib.sha1(f"{name}\x00{normalized}".encode()).hexdigest()


class LoopController:
    """Sliding-window stuck detector with a two-strike intervention policy.

    One instance per ReAct run — the window and the "already nudged" flag are
    per-run state and must not be shared across concurrent runs.
    """

    def __init__(
        self, *, window: int = DEFAULT_WINDOW, threshold: int = DEFAULT_THRESHOLD
    ) -> None:
        self._window = window
        self._threshold = threshold
        self._recent: deque[ToolAttempt] = deque(maxlen=window)
        self._nudged = False

    def record(self, attempts: list[ToolAttempt]) -> None:
        """Append one round's tool attempts (in call order) to the window."""
        for attempt in attempts:
            self._recent.append(attempt)

    def detect(self) -> StuckSignal | None:
        """Return the strongest stuck signal in the window, or ``None``.

        Priority: repeated failure (most actionable) > repeated call > A-B-A-B.
        """
        if len(self._recent) < self._threshold:
            return None

        fail_counts = Counter(a.fingerprint for a in self._recent if not a.success)
        for attempt in reversed(self._recent):
            if not attempt.success and fail_counts[attempt.fingerprint] >= self._threshold:
                return StuckSignal(
                    StuckReason.REPEATED_FAILURE,
                    attempt.tool_name,
                    fail_counts[attempt.fingerprint],
                )

        all_counts = Counter(a.fingerprint for a in self._recent)
        for attempt in reversed(self._recent):
            if all_counts[attempt.fingerprint] >= self._threshold:
                return StuckSignal(
                    StuckReason.REPEATED_CALL,
                    attempt.tool_name,
                    all_counts[attempt.fingerprint],
                )

        if len(self._recent) >= 4:
            w, x, y, z = (
                self._recent[-4],
                self._recent[-3],
                self._recent[-2],
                self._recent[-1],
            )
            if (
                w.fingerprint == y.fingerprint
                and x.fingerprint == z.fingerprint
                and w.fingerprint != x.fingerprint
            ):
                return StuckSignal(StuckReason.ALTERNATING, z.tool_name, 2)

        return None

    def decide(self, signal: StuckSignal | None) -> Intervention:
        """Map a signal to an action via a two-strike ladder.

        First trip → ``NUDGE`` and clear the window, giving the model a clean
        slate to recover (so stale repeats don't immediately re-trigger). A
        subsequent trip → ``FINALIZE``.
        """
        if signal is None:
            return Intervention.CONTINUE
        if not self._nudged:
            self._nudged = True
            self._recent.clear()
            return Intervention.NUDGE
        return Intervention.FINALIZE
