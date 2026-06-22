"""确定性 Check 单测（评估体系 §十二）：每个 Check 的过/不过分支，零真实 LLM.

走 ``build_check`` 的 spec 路径（顺带覆盖注册表映射），对构造的 ``TurnOutcome`` 断言。
"""

from agentcore.evals.checks import CHECK_NAMES, build_check
from agentcore.evals.types import EvalCase, TurnOutcome


def _case(**kw) -> EvalCase:
    base = {"id": "c", "category": "qa", "user_message": "q"}
    base.update(kw)
    return EvalCase(**base)


def _outcome(**kw) -> TurnOutcome:
    base = {"content": "hello", "finish_reason": "end_turn", "rounds": 1}
    base.update(kw)
    return TurnOutcome(**base)


def _run(spec: dict, outcome: TurnOutcome, case: EvalCase | None = None):
    return build_check(spec).run(case or _case(), outcome)


def test_finish_reason_pass_and_fail():
    assert _run({"name": "FinishReason"}, _outcome(finish_reason="end_turn")).passed
    assert not _run({"name": "FinishReason"}, _outcome(finish_reason="error")).passed
    assert not _run({"name": "FinishReason"}, _outcome(finish_reason="max_rounds")).passed
    # 自定义期望值
    assert _run(
        {"name": "FinishReason", "args": {"expected": "max_rounds"}},
        _outcome(finish_reason="max_rounds"),
    ).passed


def test_non_empty_threshold():
    assert _run({"name": "NonEmpty", "args": {"min_len": 3}}, _outcome(content="abc")).passed
    assert not _run({"name": "NonEmpty", "args": {"min_len": 10}}, _outcome(content="abc")).passed
    assert not _run({"name": "NonEmpty"}, _outcome(content="   ")).passed


def test_tool_called():
    oc = _outcome(tool_calls=[("web_search", '{"query": "x"}')])
    assert _run({"name": "ToolCalled", "args": {"tool": "web_search"}}, oc).passed
    assert not _run({"name": "ToolCalled", "args": {"tool": "file_read"}}, oc).passed


def test_tool_args_valid():
    oc = _outcome(tool_calls=[("web_search", '{"query": "x"}')])
    assert _run(
        {"name": "ToolArgsValid", "args": {"tool": "web_search", "required": ["query"]}}, oc
    ).passed
    # 缺必填键
    assert not _run(
        {"name": "ToolArgsValid", "args": {"tool": "web_search", "required": ["q"]}}, oc
    ).passed
    # 非法 JSON
    bad = _outcome(tool_calls=[("web_search", "{not json}")])
    assert not _run({"name": "ToolArgsValid", "args": {"tool": "web_search"}}, bad).passed
    # 未调用该工具
    assert not _run(
        {"name": "ToolArgsValid", "args": {"tool": "file_read"}},
        _outcome(tool_calls=[]),
    ).passed


def test_has_citations():
    oc = _outcome(citations=[{"url": "a"}, {"url": "b"}])
    assert _run({"name": "HasCitations", "args": {"min": 2}}, oc).passed
    assert not _run({"name": "HasCitations", "args": {"min": 3}}, oc).passed


def test_delegated():
    assert _run({"name": "Delegated"}, _outcome(delegated=True)).passed
    assert not _run({"name": "Delegated"}, _outcome(delegated=False)).passed


def test_not_delegated():
    assert _run({"name": "NotDelegated"}, _outcome(delegated=False)).passed
    assert not _run({"name": "NotDelegated"}, _outcome(delegated=True)).passed


def test_roster_matches_superset():
    oc = _outcome(roster=["研究员", "撰稿人", "CEO"])
    assert _run({"name": "RosterMatches", "args": {"expected": ["研究员", "撰稿人"]}}, oc).passed
    assert not _run(
        {"name": "RosterMatches", "args": {"expected": ["研究员", "测试员"]}}, oc
    ).passed


def test_max_rounds_budget():
    assert _run({"name": "MaxRounds", "args": {"budget": 3}}, _outcome(rounds=2)).passed
    assert not _run({"name": "MaxRounds", "args": {"budget": 3}}, _outcome(rounds=5)).passed


def test_max_tool_calls_budget():
    oc = _outcome(tool_calls=[("web_search", "{}")] * 5)
    assert _run({"name": "MaxToolCalls", "args": {"budget": 5}}, oc).passed
    assert not _run({"name": "MaxToolCalls", "args": {"budget": 4}}, oc).passed


def test_no_fabrication_marker():
    oc = _outcome(content="我无法确认这个信息。")
    assert _run({"name": "NoFabricationMarker", "args": {"forbidden": ["你的猫叫"]}}, oc).passed
    hit = _outcome(content="你的猫叫咪咪。")
    assert not _run(
        {"name": "NoFabricationMarker", "args": {"forbidden": ["你的猫叫"]}}, hit
    ).passed
    # 空 forbidden 恒过
    assert _run({"name": "NoFabricationMarker"}, hit).passed


def test_registry_contains_all_documented_checks():
    expected = {
        "FinishReason",
        "NonEmpty",
        "ToolCalled",
        "ToolArgsValid",
        "HasCitations",
        "Delegated",
        "RosterMatches",
        "MaxRounds",
        "NoFabricationMarker",
    }
    assert expected <= CHECK_NAMES
