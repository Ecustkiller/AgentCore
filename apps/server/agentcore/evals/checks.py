"""确定性 Check（评估体系 §五）：判定无需 LLM.

每个 Check 从 ``{"name", "args"}`` 规格经 :func:`build_check` 实例化；注册表的键集
（:data:`CHECK_NAMES`）供 ``seed_lint`` 校验用例里引用的 check 名是否存在。
Check 读 :class:`TurnOutcome`，返回 :class:`CheckOutcome`。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from agentcore.evals.types import CheckOutcome, EvalCase, TurnOutcome


@dataclass
class FinishReasonCheck:
    """回合正常收口（默认 ``end_turn``，即非 error / max_rounds / degraded / unproductive）。"""

    expected: str = "end_turn"
    name: str = "FinishReason"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        ok = outcome.finish_reason == self.expected
        return CheckOutcome(self.name, ok, f"finish_reason={outcome.finish_reason!r}")


@dataclass
class NonEmptyCheck:
    """回复正文非空、长度达阈值。"""

    min_len: int = 1
    name: str = "NonEmpty"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        n = len((outcome.content or "").strip())
        return CheckOutcome(self.name, n >= self.min_len, f"len={n} (min {self.min_len})")


@dataclass
class ToolCalledCheck:
    """调用了指定工具（按工具名匹配，至少一次）。"""

    tool: str = ""
    name: str = "ToolCalled"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        names = [t[0] for t in outcome.tool_calls]
        ok = self.tool in names
        return CheckOutcome(self.name, ok, f"want {self.tool!r} in {names}")


@dataclass
class ToolArgsValidCheck:
    """指定工具的入参 JSON 合法、且含必填键（``tool`` 为空时校验所有工具调用）。"""

    tool: str | None = None
    required: list[str] = field(default_factory=list)
    name: str = "ToolArgsValid"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        matched = [
            (n, a) for (n, a) in outcome.tool_calls if self.tool is None or n == self.tool
        ]
        if not matched:
            return CheckOutcome(self.name, False, f"no call to {self.tool!r}")
        for n, raw in matched:
            try:
                args = json.loads(raw) if raw else {}
            except json.JSONDecodeError as e:
                return CheckOutcome(self.name, False, f"{n}: bad JSON ({e})")
            missing = [k for k in self.required if k not in args]
            if missing:
                return CheckOutcome(self.name, False, f"{n}: missing {missing}")
        return CheckOutcome(self.name, True, f"{len(matched)} call(s) valid")


@dataclass
class HasCitationsCheck:
    """引用数达阈值（检索类用例）。"""

    min_count: int = 1
    name: str = "HasCitations"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        n = len(outcome.citations)
        return CheckOutcome(self.name, n >= self.min_count, f"citations={n} (min {self.min_count})")


@dataclass
class DelegatedCheck:
    """本回合确实委派了团队。"""

    name: str = "Delegated"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        return CheckOutcome(self.name, outcome.delegated, f"delegated={outcome.delegated}")


@dataclass
class RosterMatchesCheck:
    """实际委派出的角色覆盖期望角色（``roster ⊇ expected``）。"""

    expected: list[str] = field(default_factory=list)
    name: str = "RosterMatches"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        actual = set(outcome.roster)
        missing = [r for r in self.expected if r not in actual]
        ok = not missing
        return CheckOutcome(self.name, ok, f"roster={outcome.roster}, missing={missing}")


@dataclass
class MaxRoundsCheck:
    """轮数不超过预算（探测空转 / 收敛差）。"""

    budget: int = 16
    name: str = "MaxRounds"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        ok = outcome.rounds <= self.budget
        return CheckOutcome(self.name, ok, f"rounds={outcome.rounds} (budget {self.budget})")


@dataclass
class NoFabricationMarkerCheck:
    """回复不含编造痕迹（确定性子集：禁用短语命中即判失败）。

    完整的「不编造」靠 LLM 裁判（§六）；本 Check 只兜确定性可判的明显信号——例如声称
    使用了未提供的工具/能力的固定话术，经 ``args.forbidden`` 配置。空列表则恒过。
    """

    forbidden: list[str] = field(default_factory=list)
    name: str = "NoFabricationMarker"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        text = outcome.content or ""
        hit = [p for p in self.forbidden if p in text]
        return CheckOutcome(self.name, not hit, f"forbidden hits={hit}")


# 注册表：check 名 → 从 args 构造实例。新增 Check 在此登记，seed_lint 据键集校验。
_REGISTRY: dict[str, Callable[[dict[str, Any]], Any]] = {
    "FinishReason": lambda a: FinishReasonCheck(expected=a.get("expected", "end_turn")),
    "NonEmpty": lambda a: NonEmptyCheck(min_len=int(a.get("min_len", 1))),
    "ToolCalled": lambda a: ToolCalledCheck(tool=a.get("tool", "")),
    "ToolArgsValid": lambda a: ToolArgsValidCheck(
        tool=a.get("tool"), required=list(a.get("required", []))
    ),
    "HasCitations": lambda a: HasCitationsCheck(min_count=int(a.get("min", 1))),
    "Delegated": lambda a: DelegatedCheck(),
    "RosterMatches": lambda a: RosterMatchesCheck(expected=list(a.get("expected", []))),
    "MaxRounds": lambda a: MaxRoundsCheck(budget=int(a.get("budget", 16))),
    "NoFabricationMarker": lambda a: NoFabricationMarkerCheck(
        forbidden=list(a.get("forbidden", []))
    ),
}

CHECK_NAMES: frozenset[str] = frozenset(_REGISTRY)


def build_check(spec: dict[str, Any]) -> Any:
    """从 ``{"name", "args"}`` 规格构造一个 Check 实例（名未注册则 KeyError）。"""
    name = spec["name"]
    args = spec.get("args") or {}
    return _REGISTRY[name](args)
