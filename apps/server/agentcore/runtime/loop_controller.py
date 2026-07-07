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
# Consecutive empty-response rounds that trip a degraded finish (B2). The fallback
# retry sits inside this streak, so the default 2 = one empty → fallback retry → if
# still empty, degraded.
DEFAULT_EMPTY_THRESHOLD = 2
# Tool failure circuit breaker (B2): cumulative (run-scoped, args-agnostic) failure
# counts per tool. At the warn threshold the model is told to stop retrying that
# tool; at the disable threshold the tool is removed from the toolset for the rest
# of the run. Unlike REPEATED_FAILURE detection (which keys on the exact call
# fingerprint within the sliding window), this counts a tool failing *any* way and
# never resets — it catches "this tool just isn't working out, no matter the args".
DEFAULT_TOOL_FAILURE_WARN = 2
DEFAULT_TOOL_FAILURE_DISABLE = 3
# Consecutive *unproductive* rounds that trip an early stop (B2 无产出早停). An
# unproductive round = the model called ≥1 tool, every call FAILED, and it produced
# no content — it is "working" but getting nowhere. Distinct from an empty round
# (no tool call at all → degraded ladder).
DEFAULT_UNPRODUCTIVE_THRESHOLD = 3
# Periodic progress-review reflection (B2 反思注入): on a long multi-round run, inject
# a "step back and re-plan" prompt starting at the 4th round (0-indexed 3) and every
# 3 rounds after (rounds 4 / 7 / 10 …). Cadence-driven and proactive — unlike the
# event-driven NUDGE, which only fires once a mechanical loop is detected.
DEFAULT_REFLECTION_START_ROUND = 3
DEFAULT_REFLECTION_INTERVAL = 3


def progress_review_prompt(round_number: int) -> str:
    """The periodic progress-review steer (B2 反思注入), anchored to the round count.

    A structured "step back" prompt — not open-ended self-doubt — that asks the model
    to consolidate facts, name the gap to the goal, and pick the next concrete action
    (and to just answer if it already has enough), keeping a long run from drifting.
    """
    return (
        f"[系统提示] 进度复盘（已进行 {round_number} 轮）：请先停下来梳理——"
        "(1) 目前已确认了哪些关键事实？(2) 距离用户的目标还差什么？"
        "(3) 下一步最有效的具体动作是什么？避免重复已经做过的尝试；"
        "若现有信息已足够，请直接给出最终答案。"
    )


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
    # B2 degraded handling: the model returned an empty response — retry the round
    # once on the profile's fallback model before treating it as terminal.
    FALLBACK = "fallback"


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


@dataclass(frozen=True)
class CircuitBreak:
    """Tools that crossed a cumulative-failure threshold this round (B2 熔断).

    ``warned`` hit the warn threshold (tell the model to stop retrying them);
    ``disabled`` hit the disable threshold (the engine removes them from the
    toolset for the rest of the run). Each is a tuple of tool names; both empty
    means nothing tripped this round.
    """

    warned: tuple[str, ...] = ()
    disabled: tuple[str, ...] = ()

    def __bool__(self) -> bool:
        return bool(self.warned or self.disabled)

    def message(self) -> str | None:
        """The single ``[系统提示]`` to inject this round, or ``None``.

        Anchored to the concrete fact (which tool, what now happens) like the
        nudge messages — disable first (the stronger action), then warn.
        """
        parts: list[str] = []
        if self.disabled:
            names = "、".join(f"`{n}`" for n in self.disabled)
            parts.append(
                f"工具 {names} 已多次失败，本回合起停用，无法再调用——"
                "请改用其他工具或基于已有信息推进。"
            )
        if self.warned:
            names = "、".join(f"`{n}`" for n in self.warned)
            parts.append(
                f"工具 {names} 已多次失败，请不要再以相同方式调用它："
                "换不同的输入、换一个工具，或基于已有信息直接推进。"
            )
        if not parts:
            return None
        return "[系统提示] " + " ".join(parts)


def fingerprint_tool_call(name: str, arguments: str) -> str:
    """Stable hash of ``(tool_name, normalized args)``.

    Args are normalized via key-sorted JSON so semantically identical calls map
    to one fingerprint; malformed JSON falls back to the raw argument string so
    verbatim repeats are still caught.
    """
    try:
        parsed = json.loads(arguments) if arguments else {}
        normalized = json.dumps(parsed, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    except (json.JSONDecodeError, TypeError):
        normalized = arguments or ""
    return hashlib.sha1(f"{name}\x00{normalized}".encode()).hexdigest()


class LoopController:
    """Sliding-window stuck detector with a two-strike intervention policy.

    One instance per ReAct run — the window and the "already nudged" flag are
    per-run state and must not be shared across concurrent runs.
    """

    def __init__(
        self,
        *,
        window: int = DEFAULT_WINDOW,
        threshold: int = DEFAULT_THRESHOLD,
        empty_threshold: int = DEFAULT_EMPTY_THRESHOLD,
        tool_failure_warn: int = DEFAULT_TOOL_FAILURE_WARN,
        tool_failure_disable: int = DEFAULT_TOOL_FAILURE_DISABLE,
        unproductive_threshold: int = DEFAULT_UNPRODUCTIVE_THRESHOLD,
        reflection_start_round: int = DEFAULT_REFLECTION_START_ROUND,
        reflection_interval: int = DEFAULT_REFLECTION_INTERVAL,
        convergence_finalize_rounds: int = 0,
        investigation_tools: frozenset[str] = frozenset(),
    ) -> None:
        self._window = window
        self._threshold = threshold
        self._empty_threshold = max(1, empty_threshold)
        self._tool_failure_warn = max(1, tool_failure_warn)
        self._tool_failure_disable = max(self._tool_failure_warn, tool_failure_disable)
        self._unproductive_threshold = max(1, unproductive_threshold)
        self._reflection_start_round = max(0, reflection_start_round)
        self._reflection_interval = max(1, reflection_interval)
        self._recent: deque[ToolAttempt] = deque(maxlen=window)
        self._nudged = False
        self._investigation_tools = investigation_tools
        # ``investigation_calls`` = cumulative read-only calls (run-scoped); ``investigation
        # _rounds`` = rounds with >=1 such call. The over-investigation safety net triggers
        # on ROUNDS, not calls, so a parallel batch (several reads in one round) counts once
        # and can't guillotine a worker after a single fan-out. Both feed the finalize log.
        self._investigation_calls = 0
        self._investigation_rounds = 0
        # Over-investigation safety net (收敛治理, 保险丝): a pure runaway backstop. The soft
        # nudge that once lived here was empirically ignored AND net-negative in A/B (cost ↑,
        # no call reduction), so convergence discipline moved into the system prompt (frame
        # from round 0) + the read_url failure guidance; this only FINALIZEs a true runaway
        # that keeps investigating past ``finalize_rounds``. ``finalize_rounds <= 0`` disables.
        self._convergence_finalize_rounds = max(0, convergence_finalize_rounds)
        # B2 empty-response sub-policy: a separate consecutive-empty-round counter
        # (NOT the tool-attempt window) and a one-shot "已用过 fallback" latch.
        self._consecutive_empty = 0
        self._fell_back = False
        # B2 tool circuit breaker: cumulative per-tool failure counts (run-scoped,
        # never cleared by the nudge window reset) + one-shot latches so each tool
        # fires its warn / disable transition at most once.
        self._tool_failures: Counter[str] = Counter()
        self._tool_warned: set[str] = set()
        self._tool_disabled: set[str] = set()
        # B2 no-output early stop: consecutive unproductive rounds (all tools failed,
        # no content). Reset by any productive round (content OR a tool success).
        self._consecutive_unproductive = 0
        # Post-delegate synthesis mode (优化六): after delegate returns, steer the CEO away
        # from repeating investigation work the team already did.
        self._post_delegate: bool = False
        self._post_delegate_investigation_count: int = 0

    def mark_post_delegate(self) -> None:
        """Mark that a delegate call just returned — CEO is now in synthesis mode."""
        self._post_delegate = True
        self._post_delegate_investigation_count = 0

    def post_delegate_check(self, tool_names: set[str]) -> str | None:
        """Check if CEO is doing investigation work after delegating.

        Returns a reminder message if needed, None otherwise.
        """
        if not self._post_delegate:
            return None
        investigation_used = tool_names & self._investigation_tools
        if not investigation_used:
            return None
        self._post_delegate_investigation_count += 1
        if self._post_delegate_investigation_count == 1:
            return (
                "[系统提示] 你已将此工作委派给团队。请直接基于团队的产出写综述，"
                "不要重复调查。如需验证某个具体细节可读 worker 产出的文件，"
                "但不要展开新的调研。"
            )
        if self._post_delegate_investigation_count == 2:
            return (
                "[系统提示] 你仍在做已委派给团队的调查工作。请立即停止调研，"
                "基于团队已有产出写综述收尾。"
            )
        return None  # 第三次由 convergence_action 处理

    def record(self, attempts: list[ToolAttempt]) -> None:
        """Append one round's tool attempts (in call order) to the window.

        Also bumps the run-scoped per-tool cumulative failure tally that drives the
        circuit breaker — independent of the sliding window (which the nudge reset
        clears), since "this tool keeps failing" is a whole-run signal.
        """
        round_investigated = False
        for attempt in attempts:
            self._recent.append(attempt)
            if not attempt.success:
                self._tool_failures[attempt.tool_name] += 1
            # Over-investigation bookkeeping (收敛治理): tally read-only investigation
            # breadth. Counts every call (incl. failures) — a wide scan is breadth
            # regardless of per-call success.
            if attempt.tool_name in self._investigation_tools:
                self._investigation_calls += 1
                round_investigated = True
        # Rounds, not raw calls, drive the safety net: a parallel batch of N reads in one
        # round bumps this once, so fanning out can't guillotine the worker.
        if round_investigated:
            self._investigation_rounds += 1

    def note_empty_round(self, is_empty: bool) -> None:
        """Track consecutive empty-response rounds (B2).

        An empty round = the model produced no content and called no tool. A
        non-empty round (real answer OR a tool call) resets the streak — so only
        *consecutive* empties escalate toward a degraded finish.
        """
        self._consecutive_empty = self._consecutive_empty + 1 if is_empty else 0

    def empty_response_action(self, *, fallback_available: bool) -> Intervention:
        """Decide what to do after an empty round (B2 degraded ladder).

        ``FINALIZE`` once the consecutive-empty streak hits the threshold (the turn
        ends as degraded rather than blank); else ``FALLBACK`` for the first empty
        when a fallback model is available and unused (retry the round on it); else
        ``CONTINUE`` (retry the round as-is). The fallback latch ensures we escalate
        the model at most once per run.
        """
        if self._consecutive_empty >= self._empty_threshold:
            return Intervention.FINALIZE
        if fallback_available and not self._fell_back:
            self._fell_back = True
            return Intervention.FALLBACK
        return Intervention.CONTINUE

    def tool_circuit_breaker(self) -> CircuitBreak:
        """Tools whose cumulative failures crossed a threshold (call after ``record``).

        Returns the tools that *newly* hit the warn / disable threshold this round
        (each transition fires once per tool per run). The engine injects the
        :meth:`CircuitBreak.message` and removes any ``disabled`` tools from the
        toolset for the remaining rounds. A tool that leaps straight to the disable
        count is only disabled (no redundant warn).
        """
        newly_warned: list[str] = []
        newly_disabled: list[str] = []
        for name, count in self._tool_failures.items():
            if name in self._tool_disabled:
                continue
            if count >= self._tool_failure_disable:
                self._tool_disabled.add(name)
                self._tool_warned.discard(name)
                newly_disabled.append(name)
            elif count >= self._tool_failure_warn and name not in self._tool_warned:
                self._tool_warned.add(name)
                newly_warned.append(name)
        return CircuitBreak(warned=tuple(newly_warned), disabled=tuple(newly_disabled))

    def tool_failure_count(self, tool_name: str) -> int:
        """Cumulative failure count for one tool in this run (circuit breaker input)."""
        return int(self._tool_failures.get(tool_name, 0))

    def note_round_productivity(
        self, *, had_tool_calls: bool, all_failed: bool, had_content: bool
    ) -> None:
        """Track consecutive *unproductive* rounds (B2 无产出早停).

        An unproductive round = the model called ≥1 tool, every call failed, and it
        produced no content. Any productive round — content this round, a tool
        success, or a no-tool round (handled by the empty/degraded path) — resets
        the streak, so only a sustained all-failing-no-output run escalates.
        """
        unproductive = had_tool_calls and all_failed and not had_content
        self._consecutive_unproductive = self._consecutive_unproductive + 1 if unproductive else 0

    def unproductive_early_stop(self) -> bool:
        """True once the consecutive-unproductive streak hits the threshold."""
        return self._consecutive_unproductive >= self._unproductive_threshold

    def reflection_due(self, round_idx: int) -> bool:
        """Whether to inject a periodic progress-review reflection (B2 反思注入).

        Fires on a fixed cadence — at ``reflection_start_round`` (0-indexed) and every
        ``reflection_interval`` rounds after (default: round_idx 3 / 6 / 9 …, i.e. the
        4th / 7th / 10th round). The prompt the next round sees comes from
        :func:`progress_review_prompt`. Independent of the stuck detector: this is a
        proactive "re-plan" beat for long runs, not a reaction to a detected loop.
        """
        if round_idx < self._reflection_start_round:
            return False
        return (round_idx - self._reflection_start_round) % self._reflection_interval == 0

    @property
    def investigation_calls(self) -> int:
        """Cumulative read-only investigation calls this run (finalize-log diagnostic)."""
        return self._investigation_calls

    @property
    def investigation_rounds(self) -> int:
        """Rounds with >=1 read-only investigation call (the safety net's batch-robust clock)."""
        return self._investigation_rounds

    def convergence_action(self) -> Intervention:
        """Over-investigation safety net: ``FINALIZE`` a true runaway, else ``CONTINUE``.

        Keyed on investigation *rounds* (:attr:`investigation_rounds`) so a parallel
        batch counts once. Returns ``FINALIZE`` only once the run keeps investigating past
        ``finalize_rounds`` — a deliberately HIGH bar (a pure runaway backstop, e.g. the
        17-round pathology), not a routine convergence tool: the soft nudge that once lived
        here was empirically ignored and net-negative, so convergence discipline now lives
        in the system prompt + the read_url failure guidance. Dormant (``CONTINUE``) when
        ``finalize_rounds <= 0``.
        """
        if self._convergence_finalize_rounds <= 0:
            return Intervention.CONTINUE
        if self._investigation_rounds >= self._convergence_finalize_rounds:
            return Intervention.FINALIZE
        return Intervention.CONTINUE

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
