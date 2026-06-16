"""核心数据类型 + 协议（评估体系 §三）.

纯模块：仅 dataclass + Protocol，不 import runtime/LLM，故可独立单测。
``EvalCase`` 是黄金用例（数据），``TurnOutcome`` 是 harness 把一次真实运行归一化成的
可断言事实，``Check``/``Judge``/``Harness`` 是三个解耦点。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

EvalCategory = Literal["qa", "retrieval", "team", "tool_use", "no_fabrication", "routing"]
RunPath = Literal["single", "team"]
ToolsetName = Literal["ceo", "worker"]


class EvalConfigError(Exception):
    """用例配置/加载期错误（lint 失败、套件目录缺失、fixture 目录不存在等）.

    纯静态错误，与运行模型无关；CLI 捕获后以非 0 退出，per-PR 硬门禁据此阻断。
    """


@dataclass
class EvalCase:
    """一个黄金用例。从 ``cases/*.json`` 加载（loader 解析为本类型）。

    ``checks`` 是声明式断言 ``[{"name": str, "args": {...}}]``，由 ``checks.build_check``
    解析；期望委派角色等参数统一进 ``args``（如 ``RosterMatches`` 的 ``args.expected``）。
    ``rubric`` 非空时走 LLM 裁判（P1）；``samples`` >1 为重跑取通过率（治非确定性）。
    """

    id: str
    category: EvalCategory
    user_message: str
    path: RunPath = "single"
    mode: str = "economy"
    toolset: ToolsetName = "ceo"
    workspace_fixture: str | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    checks: list[dict[str, Any]] = field(default_factory=list)
    rubric: str | None = None
    samples: int = 1


@dataclass
class TurnOutcome:
    """harness 把一次真实运行归一化成可断言的事实。

    单 Agent 路径的 ``finish_reason`` 由轮数推导（``react_loop`` 不返回它）；``roster``
    取自 ``run_plan.agents[*].role``（team 路径）；``cost_usd`` 单 Agent 现算、team 读
    ``cost_runs``。
    """

    content: str
    finish_reason: str
    rounds: int
    tool_calls: list[tuple[str, str]] = field(default_factory=list)
    citations: list[dict[str, Any]] = field(default_factory=list)
    delegated: bool = False
    roster: list[str] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    cost_usd: float = 0.0
    latency_ms: int = 0
    error: str | None = None


@dataclass
class CheckOutcome:
    """一个确定性 Check 的判定结果。"""

    name: str
    passed: bool
    detail: str = ""


@dataclass
class JudgeVerdict:
    """LLM 裁判对一次运行的语义打分（P1）。"""

    score: float
    passed: bool
    rationale: str


@dataclass
class CaseReport:
    """一次用例运行的完整报告（确定性 Check + 可选裁判 + 归一化 outcome）。"""

    case_id: str
    category: str
    outcome: TurnOutcome
    checks: list[CheckOutcome] = field(default_factory=list)
    judge: JudgeVerdict | None = None

    @property
    def checks_passed(self) -> bool:
        return all(c.passed for c in self.checks)

    @property
    def passed(self) -> bool:
        """判定口径（§五 5.3）：规则断言全过 且（无裁判 or 裁判通过）且未报错。"""
        judge_ok = self.judge is None or self.judge.passed
        return self.checks_passed and judge_ok and self.outcome.error is None


@dataclass
class EvalReport:
    """一次评测跑的聚合报告（一个或多个 ``CaseReport``，samples>1 时同 case_id 多条）。"""

    cases: list[CaseReport] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.cases)

    @property
    def passed(self) -> int:
        return sum(1 for c in self.cases if c.passed)

    @property
    def pass_rate(self) -> float:
        return self.passed / self.total if self.total else 0.0


@runtime_checkable
class Check(Protocol):
    """确定性断言：判定不调 LLM。"""

    name: str

    def run(self, case: EvalCase, outcome: TurnOutcome) -> CheckOutcome: ...


class Judge(Protocol):
    """LLM 裁判：按 rubric 给语义分（P1，用 ``LLMProvider.complete``）。"""

    async def score(self, case: EvalCase, outcome: TurnOutcome) -> JudgeVerdict: ...


class Harness(Protocol):
    """「怎么离线跑一例」与评分逻辑解耦。"""

    async def run_case(self, case: EvalCase) -> TurnOutcome: ...


# ---------------------------------------------------------------------------
# 对比评估（团队 vs 单体）—— 见 docs/07-规划/多Agent对比评估设计.md
#
# 与上面的「功能评估」正交：那套判单条回合对不对（绝对正确性 + 绝对分裁判）；
# 这套判同一任务下「多 Agent 是否真比单 Agent 好」（多臂对照 + 成对偏好裁判）。
# 本段仍是纯类型（不 import runtime/LLM），故可随 __init__ 静态暴露。
# ---------------------------------------------------------------------------

EvalArchetype = Literal["parallel_research", "debate", "cross_domain", "simple"]


@dataclass
class ComparisonCase:
    """一个对比用例：同一任务跑过多个「臂」（single / team / …），比较产出优劣。

    与 :class:`EvalCase`（单 path、绝对判定）正交：本类一条 = 一道题 × 多臂，runner 为
    每个臂合成一个 :class:`EvalCase` 喂现有 harness（零侵入）。``baseline_arm`` 是被比较的
    基准（默认单体），其余臂逐一与之成对裁判。``checks`` 按臂可选（``{arm: [{name,args}]}``），
    服务 pass^k 可靠性；``rubric`` 非空才走成对裁判（P0 self-test 注入假裁判）。``arms`` 中
    ``matched_single``（等算力单体）为 P1，P0 仅 ``single``/``team``。
    """

    id: str
    archetype: EvalArchetype
    user_message: str
    arms: list[str] = field(default_factory=lambda: ["single", "team"])
    baseline_arm: str = "single"
    mode: str = "economy"
    toolset: ToolsetName = "ceo"
    workspace_fixture: str | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    checks: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    rubric: str | None = None
    samples: int = 1


@dataclass
class PairwiseVerdict:
    """成对裁判对「主臂 vs 基准臂」一次比较的结论（盲评 + 位置对调后的合议）。"""

    winner: str  # 胜出臂名，或 "tie"
    rationale: str = ""
    margin: int = 0  # 0–3 优势强度（可选）


@dataclass
class ArmResult:
    """一个臂在某对比用例下的全部采样结果（k 次）+ 逐采样的确定性 Check。"""

    arm: str
    outcomes: list[TurnOutcome] = field(default_factory=list)
    checks: list[list[CheckOutcome]] = field(default_factory=list)

    @property
    def passk(self) -> bool | None:
        """pass^k：k 次采样的 Check 全过才 True；该臂未声明 Check 则 None（不判）。"""
        if not self.checks or not any(self.checks):
            return None
        return all(all(c.passed for c in sample) for sample in self.checks)


@dataclass
class ComparisonCaseReport:
    """一道对比用例的完整报告：各臂结果 + 主臂逐对裁判结论。"""

    case_id: str
    archetype: str
    baseline_arm: str
    arms: dict[str, ArmResult] = field(default_factory=dict)
    pairwise: dict[str, list[PairwiseVerdict]] = field(default_factory=dict)

    @property
    def subject_arms(self) -> list[str]:
        """除基准外的「被检验臂」（默认就是 team）。"""
        return [a for a in self.arms if a != self.baseline_arm]


@dataclass
class ComparisonReport:
    """一次对比评测跑的聚合（多道对比用例）。"""

    cases: list[ComparisonCaseReport] = field(default_factory=list)


class PairwiseJudge(Protocol):
    """成对语义裁判：判「主臂 vs 基准臂」哪个更好（盲评、先理由后结论）。"""

    async def compare(
        self,
        *,
        rubric: str,
        user_message: str,
        subject_arm: str,
        subject_content: str,
        baseline_arm: str,
        baseline_content: str,
    ) -> PairwiseVerdict: ...
