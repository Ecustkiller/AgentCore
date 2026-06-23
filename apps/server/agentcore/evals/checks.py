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

from agentcore.evals.style_lint import style_violations
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
        matched = [(n, a) for (n, a) in outcome.tool_calls if self.tool is None or n == self.tool]
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
class NotDelegatedCheck:
    """本回合**没有**委派团队（``DelegatedCheck`` 的护栏逆否）。

    探测「过度编排」——简单问题本该 CEO 直接答，却拆成一支团队，是 Multi-Agent 产品
    最典型的体验/成本灾难。须走 ``path="team"`` 才有意义（``single`` 路径恒不委派、
    断言会平凡通过）；功能套件据此守住「简单问题零编排」这条护栏。
    """

    name: str = "NotDelegated"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        return CheckOutcome(self.name, not outcome.delegated, f"delegated={outcome.delegated}")


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
class MaxToolCallsCheck:
    """工具调用总数不超过预算（探测检索 / 工具滥用——团队任务尤甚）。

    读 ``outcome.tool_calls`` 长度（含被委派 worker 的调用，由 ``RecordingSink`` 全量截获）。
    与 ``MaxRounds`` 正交：轮数看 ReAct 节奏，工具数看「检索 / 读取是否泛滥」——一道团队任务
    打数十次 ``web_search`` 的成本 / 延迟灾难，靠它才可量化、可回归。
    """

    budget: int = 24
    name: str = "MaxToolCalls"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        n = len(outcome.tool_calls)
        return CheckOutcome(self.name, n <= self.budget, f"tool_calls={n} (budget {self.budget})")


@dataclass
class StyleCleanCheck:
    """回复无 anti-slop 风格违规（方向④确定性护栏）。

    跑 ``style_lint.style_violations`` 检测套话开场 / 客套收尾 / 未授权 emoji（纯文本、零
    LLM，详见 ``style_lint.py``）。``args.allow`` 可豁免规则——典型是用户自己用了 emoji 时
    放行 ``"emoji"``，与 ``<output_style>`` 的 emoji soft carve-out 对齐。
    """

    allow: list[str] = field(default_factory=list)
    name: str = "StyleClean"

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome:
        violations = [v for v in style_violations(outcome.content) if v.rule not in self.allow]
        ok = not violations
        detail = "clean" if ok else "; ".join(f"{v.rule}:{v.snippet}" for v in violations)
        return CheckOutcome(self.name, ok, detail)


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
    "NotDelegated": lambda a: NotDelegatedCheck(),
    "RosterMatches": lambda a: RosterMatchesCheck(expected=list(a.get("expected", []))),
    "MaxRounds": lambda a: MaxRoundsCheck(budget=int(a.get("budget", 16))),
    "MaxToolCalls": lambda a: MaxToolCallsCheck(budget=int(a.get("budget", 24))),
    "NoFabricationMarker": lambda a: NoFabricationMarkerCheck(
        forbidden=list(a.get("forbidden", []))
    ),
    "StyleClean": lambda a: StyleCleanCheck(allow=list(a.get("allow", []))),
}

CHECK_NAMES: frozenset[str] = frozenset(_REGISTRY)

# 诊断 Check（轨迹形状）：仍注册、仍跑、仍报告，但**不计入** pass/fail（评测体系重设计 §三/§六）。
# 「派没派 / roster 对不对」是编排手段，不是任务结果——把它当 golden 标签会变成回归测试作者的
# 编排理论（「实现冒充需求」）。过度编排改由「个体贡献=0 + L0 成本预算」度量，期望角色改由 L1
# milestone 覆盖度量。``runner.apply_checks`` 据此集合把对应 CheckOutcome 标为 gating=False。
DIAGNOSTIC_CHECKS: frozenset[str] = frozenset({"Delegated", "NotDelegated", "RosterMatches"})


def build_check(spec: dict[str, Any]) -> Any:
    """从 ``{"name", "args"}`` 规格构造一个 Check 实例（名未注册则 KeyError）。"""
    name = spec["name"]
    args = spec.get("args") or {}
    return _REGISTRY[name](args)
