"""L1 绝对分裁判 + 诊断 Check 不计入判定 + baseline 回归门 单测（后端架构.md §五）.

零真实 LLM：注入返回固定 JSON 的假 provider 验证 :class:`LLMJudge` 解析/阈值/多采样/容错；
用合成 ``TurnOutcome`` 验证诊断 Check 落 ``gating=False`` 不影响 ``CaseReport.passed``；纯函数
验证回归门。真模型留给 nightly。
"""

import asyncio
import json

from agentcore.evals.judge import LLMJudge
from agentcore.evals.report import baseline_regression, report_to_dict
from agentcore.evals.runner import apply_checks, run_suite
from agentcore.evals.types import CaseReport, EvalCase, EvalReport, TurnOutcome
from agentcore.llm.provider.protocol import LLMResponse

# --- 假裁判 provider ---------------------------------------------------------


class _FixedScoreProvider:
    """每次 complete 返回固定 score 的 JSON（``calls`` 记调用数，验证多采样次数）。"""

    def __init__(self, score: int, rationale: str = "r") -> None:
        self._score = score
        self._rationale = rationale
        self.calls = 0

    async def complete(self, request):  # noqa: ANN001
        self.calls += 1
        return LLMResponse(content=json.dumps({"score": self._score, "rationale": self._rationale}))


class _SequenceScoreProvider:
    """按序返回不同 score（验证多采样取均分）。"""

    def __init__(self, scores: list[int]) -> None:
        self._it = iter(scores)

    async def complete(self, request):  # noqa: ANN001
        return LLMResponse(content=json.dumps({"score": next(self._it), "rationale": "r"}))


class _GarbageProvider:
    async def complete(self, request):  # noqa: ANN001
        return LLMResponse(content="没有 JSON 的废话")


def _case(rubric: str | None = "好不好", **kw) -> EvalCase:
    base = {"id": "c", "category": "qa", "user_message": "q", "rubric": rubric}
    base.update(kw)
    return EvalCase(**base)


def _outcome(content: str = "答案", **kw) -> TurnOutcome:
    base = {"content": content, "finish_reason": "end_turn", "rounds": 1}
    base.update(kw)
    return TurnOutcome(**base)


# --- LLMJudge 绝对分 ---------------------------------------------------------


def test_llm_judge_passes_at_or_above_threshold():
    judge = LLMJudge(_FixedScoreProvider(5), "m", pass_threshold=4.0)
    v = asyncio.run(judge.score(_case(), _outcome()))
    assert v.score == 5.0
    assert v.passed is True


def test_llm_judge_fails_below_threshold():
    judge = LLMJudge(_FixedScoreProvider(3), "m", pass_threshold=4.0)
    v = asyncio.run(judge.score(_case(), _outcome()))
    assert v.score == 3.0
    assert v.passed is False


def test_llm_judge_multisample_averages_and_calls_n_times():
    prov = _SequenceScoreProvider([5, 3])  # 均分 4.0
    judge = LLMJudge(prov, "m", pass_threshold=4.0, samples=2)
    v = asyncio.run(judge.score(_case(), _outcome()))
    assert v.score == 4.0
    assert v.passed is True
    assert "2 采样" in v.rationale


def test_llm_judge_bad_json_scores_zero_and_fails():
    judge = LLMJudge(_GarbageProvider(), "m")
    v = asyncio.run(judge.score(_case(), _outcome()))
    assert v.score == 0.0
    assert v.passed is False


# --- run_suite 接入裁判（layer 2） -------------------------------------------


class _OneOutcomeHarness:
    def __init__(self, outcome: TurnOutcome) -> None:
        self._oc = outcome

    async def run_case(self, case):  # noqa: ANN001
        return self._oc


def test_run_suite_layer2_attaches_judge_and_gates_on_it():
    # L0 check 全过、但裁判判负 → CaseReport.passed=False（裁判是 L1 主轴）。
    harness = _OneOutcomeHarness(_outcome())
    case = _case(checks=[{"name": "FinishReason"}])
    judge = LLMJudge(_FixedScoreProvider(2), "m", pass_threshold=4.0)
    report = asyncio.run(run_suite([case], harness, judge=judge, layer=2))
    assert report.total == 1
    assert report.passed == 0
    c = report.cases[0]
    assert c.judge is not None and c.judge.passed is False
    assert c.checks_passed is True  # L0 仍过，是裁判把它拉下来


def test_run_suite_layer1_skips_judge():
    harness = _OneOutcomeHarness(_outcome())
    case = _case(checks=[{"name": "FinishReason"}])
    prov = _FixedScoreProvider(2)
    wrapped = LLMJudge(prov, "m")
    report = asyncio.run(run_suite([case], harness, judge=wrapped, layer=1))
    assert report.cases[0].judge is None
    assert prov.calls == 0  # layer 1 不触发裁判


# --- 诊断 Check 不计入判定 ----------------------------------------------------


def test_diagnostic_checks_do_not_gate():
    # Delegated 失败（诊断），但 L0 的 FinishReason 过 → 整体仍判过。
    case = _case(checks=[{"name": "FinishReason"}, {"name": "Delegated"}])
    oc = _outcome(delegated=False)  # Delegated 会失败
    checks = apply_checks(case, oc)
    by = {c.name: c for c in checks}
    assert by["Delegated"].passed is False
    assert by["Delegated"].gating is False  # 落标诊断
    assert by["FinishReason"].gating is True
    rep = CaseReport(case_id="c", category="qa", outcome=oc, checks=checks)
    assert rep.checks_passed is True  # 诊断不计入
    assert rep.passed is True


def test_l0_invariant_still_gates():
    case = _case(
        checks=[{"name": "FinishReason"}, {"name": "RosterMatches", "args": {"expected": ["X"]}}]
    )
    oc = _outcome(finish_reason="error", roster=[])  # FinishReason 失败（L0）
    checks = apply_checks(case, oc)
    rep = CaseReport(case_id="c", category="qa", outcome=oc, checks=checks)
    assert rep.checks_passed is False  # L0 破 → 失败（RosterMatches 诊断不影响）


def test_report_serializes_gating_flag():
    case = _case(checks=[{"name": "Delegated"}])
    oc = _outcome(delegated=True)
    rep = EvalReport(
        cases=[CaseReport(case_id="c", category="qa", outcome=oc, checks=apply_checks(case, oc))]
    )
    data = report_to_dict(rep)
    ck = data["cases"][0]["checks"][0]
    assert ck["name"] == "Delegated"
    assert ck["gating"] is False


# --- baseline 回归门 ---------------------------------------------------------


def _report_with_rate(passed: int, total: int) -> EvalReport:
    case = _case(checks=[{"name": "FinishReason"}])
    cases = []
    for i in range(total):
        oc = _outcome() if i < passed else _outcome(finish_reason="error", error="x")
        cases.append(
            CaseReport(case_id=f"c{i}", category="qa", outcome=oc, checks=apply_checks(case, oc))
        )
    return EvalReport(cases=cases)


def test_baseline_regression_flags_drop_beyond_tolerance():
    rep = _report_with_rate(7, 10)  # 0.7
    regressed, _ = baseline_regression(rep, {"summary": {"pass_rate": 0.9}}, 0.05)
    assert regressed is True


def test_baseline_regression_within_tolerance_ok():
    rep = _report_with_rate(9, 10)  # 0.9
    regressed, _ = baseline_regression(rep, {"summary": {"pass_rate": 0.92}}, 0.05)
    assert regressed is False  # 0.9 >= 0.92 - 0.05


def test_baseline_regression_improvement_ok():
    rep = _report_with_rate(10, 10)  # 1.0
    regressed, _ = baseline_regression(rep, {"summary": {"pass_rate": 0.7}}, 0.05)
    assert regressed is False
