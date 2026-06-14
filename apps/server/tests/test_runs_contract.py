"""Tests for the contract gate's mechanical checks (阶段2 第一刀).

Covers the always-on non-empty baseline, each declared rule (length / keyword /
section / json), failure collection order, and the feedback / requirements
rendering the executor uses for the retry prompt.
"""

from agentcore.runtime.runs.contract import (
    check_contract,
    describe_contract,
    format_feedback,
)
from agentcore.runtime.runs.types import RunContract


def test_empty_fails_baseline_without_contract():
    v = check_contract("   ", None)
    assert not v.ok
    assert "空" in v.failures[0]


def test_non_empty_passes_without_contract():
    v = check_contract("有内容", None)
    assert v.ok
    assert v.failures == []


def test_min_length_failure_and_pass():
    assert not check_contract("短", RunContract(min_length=10)).ok
    assert check_contract("这是一段足够长的产出内容", RunContract(min_length=5)).ok


def test_max_length_failure():
    v = check_contract("一二三四五六", RunContract(max_length=3))
    assert not v.ok
    assert any("超过" in f for f in v.failures)


def test_must_contain_failure_and_pass():
    contract = RunContract(must_contain=["风险", "结论"])
    v = check_contract("这里只讨论了结论", contract)
    assert not v.ok
    assert any("风险" in f for f in v.failures)
    assert check_contract("既有风险也有结论", contract).ok


def test_required_section_heading_shapes_detected():
    contract = RunContract(required_sections=["结论"])
    assert check_contract("# 结论\n内容", contract).ok
    assert check_contract("## 结论\n内容", contract).ok
    assert check_contract("**结论**\n内容", contract).ok
    assert check_contract("结论：完成了", contract).ok


def test_required_section_missing():
    v = check_contract("# 结论\n正文很长", RunContract(required_sections=["参考来源"]))
    assert not v.ok
    assert any("参考来源" in f for f in v.failures)


def test_required_section_incidental_mention_not_enough():
    # A keyword buried in prose is not a section heading.
    v = check_contract("我们在文中得出结论这件事很复杂", RunContract(required_sections=["结论"]))
    assert not v.ok


def test_json_format_pass_plain_and_fenced():
    contract = RunContract(output_format="json")
    assert check_contract('{"a": 1}', contract).ok
    assert check_contract('```json\n{"a": 1}\n```', contract).ok


def test_json_format_failure_on_prose():
    v = check_contract("这不是 JSON", RunContract(output_format="json"))
    assert not v.ok
    assert any("JSON" in f for f in v.failures)


def test_multiple_failures_collected():
    v = check_contract("短文本", RunContract(min_length=100, must_contain=["X"]))
    assert len(v.failures) == 2


def test_format_feedback_lists_reasons():
    fb = format_feedback(check_contract("短", RunContract(min_length=10, must_contain=["X"])))
    assert "少于" in fb
    assert "X" in fb
    assert fb.startswith("你上一次")


def test_format_feedback_empty_when_ok():
    assert format_feedback(check_contract("ok 内容", None)) == ""


def test_describe_contract_renders_rules():
    desc = describe_contract(
        RunContract(
            required_sections=["结论"], must_contain=["风险"], min_length=200, output_format="json"
        )
    )
    assert "结论" in desc
    assert "风险" in desc
    assert "200" in desc
    assert "JSON" in desc


def test_describe_contract_none_is_empty():
    assert describe_contract(None) == ""
