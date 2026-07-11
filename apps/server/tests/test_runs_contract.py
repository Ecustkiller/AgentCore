"""Tests for the contract gate's mechanical checks (阶段2 第一刀).

Covers the always-on non-empty baseline, each declared rule (length / keyword /
section / json), failure collection order, and the feedback / requirements
rendering the executor uses for the retry prompt.
"""

from agentcore.runtime.runs.contract import (
    check_contract,
    debrief_meets_minimum,
    describe_deliverable,
    format_feedback,
    node_has_dependents,
    synthesize_debrief,
)
from agentcore.runtime.runs.types import Deliverable, RunContract


def test_empty_fails_baseline_without_contract():
    v = check_contract("   ", None)
    assert not v.ok
    assert "空" in v.failures[0]


def test_empty_passes_when_files_written():
    v = check_contract("", None, files_written=1)
    assert v.ok


def test_empty_passes_when_handoff_debrief_present():
    v = check_contract("", None, debrief={"summary": "已完成写入 index.html"})
    assert v.ok


def test_empty_passes_when_handoff_has_key_points_only():
    v = check_contract("", None, debrief={"key_points": ["要点一"]})
    assert v.ok


def test_empty_still_fails_with_no_alternate_signals():
    v = check_contract("", None, files_written=0, debrief=None)
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


def test_must_contain_case_insensitive():
    # Mirrors required_sections' casefold match: casing must not flip the verdict.
    contract = RunContract(must_contain=["API", "ROI"])
    assert check_contract("本方案的 api 设计与 roi 测算如下", contract).ok
    # A genuinely missing keyword still fails, and the reason shows原始大小写.
    v = check_contract("只提到了 api 设计", contract)
    assert not v.ok
    assert any("ROI" in f for f in v.failures)


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


def test_format_feedback_steers_worker_to_skip_meta_commentary():
    # The worker has a single rework shot — spend it on the corrected product,
    # not on apologies or explanations.
    fb = format_feedback(check_contract("短", RunContract(min_length=10)))
    assert "完整最终产出" in fb
    assert "不要解释" in fb
    assert "不要道歉" in fb


def test_format_feedback_empty_when_ok():
    assert format_feedback(check_contract("ok 内容", None)) == ""


def test_describe_deliverable_renders_rules():
    desc = describe_deliverable(
        Deliverable(
            required_sections=["结论"], must_contain=["风险"], min_length=200, output_format="json"
        )
    )
    assert "结论" in desc
    assert "风险" in desc
    assert "200" in desc
    assert "JSON" in desc


def test_describe_deliverable_none_is_empty():
    assert describe_deliverable(None) == ""


def test_describe_deliverable_renders_name():
    desc = describe_deliverable(Deliverable(name="方向③-案例卡.html"))
    assert desc == "交付物：方向③-案例卡.html"


# --- requires_files: the deliverable-landed gate over files_written -------------


def test_requires_files_fails_when_none_written():
    v = check_contract("我把整份代码贴在这里", RunContract(requires_files=True), files_written=0)
    assert not v.ok
    assert any("工作区" in f for f in v.failures)


def test_requires_files_passes_when_a_file_was_written():
    assert check_contract("已写入 index.html", RunContract(requires_files=True), files_written=1).ok


def test_requires_files_off_by_default_ignores_file_count():
    # A prose contract (requires_files unset) never fails for lack of a file write.
    assert check_contract("纯文字分析", RunContract(min_length=2), files_written=0).ok


def test_describe_deliverable_renders_requires_files():
    desc = describe_deliverable(Deliverable(requires_files=True))
    assert "file_write" in desc
    assert "工作区" in desc


# --- artifacts: declarative path reconciliation ---------------------------------


def test_artifacts_pass_when_exact_path_present():
    v = check_contract(
        "done",
        RunContract(artifacts=["README.md"]),
        files_written=1,
        workspace_paths=["README.md", "src/main.py"],
    )
    assert v.ok


def test_artifacts_fail_when_path_missing():
    v = check_contract(
        "done",
        RunContract(artifacts=["README.md", "examples/demo.py"]),
        files_written=1,
        workspace_paths=["src/main.py"],
    )
    assert not v.ok
    assert any("README.md" in f for f in v.failures)
    assert any("examples/demo.py" in f for f in v.failures)


def test_artifacts_glob_and_directory_match():
    d = RunContract(artifacts=["src/**/*.py", "examples/", "pkg/"])
    assert check_contract(
        "ok",
        d,
        files_written=2,
        workspace_paths=["src/a/b.py", "examples/x.txt", "pkg/__init__.py"],
    ).ok
    v = check_contract(
        "ok",
        d,
        files_written=1,
        workspace_paths=["src/a/b.py"],
    )
    assert not v.ok
    assert any("examples/" in f for f in v.failures)


def test_artifacts_empty_workspace_all_missing():
    v = check_contract(
        "贴了代码",
        RunContract(artifacts=["a.py"]),
        files_written=0,
        workspace_paths=[],
    )
    assert not v.ok
    # requires_files is implied by artifacts in builder; here we set artifacts alone
    # so both the files_written and path checks can fire depending on flags.
    assert any("a.py" in f for f in v.failures)


def test_describe_deliverable_renders_artifacts():
    desc = describe_deliverable(Deliverable(artifacts=["README.md", "examples/*"]))
    assert "README.md" in desc
    assert "examples/*" in desc


def test_debrief_meets_minimum_summary_or_key_points():
    assert not debrief_meets_minimum(None)
    assert not debrief_meets_minimum({"summary": "太短"})
    assert debrief_meets_minimum({"summary": "x" * 50})
    assert debrief_meets_minimum({"summary": "短", "key_points": ["a", "b"]})


def test_synthesize_debrief_marks_degraded():
    d = synthesize_debrief("正文结论一段", ["a.py", "b.py"])
    assert d["degraded"] is True
    assert "正文结论" in d["summary"]
    assert d["key_points"]


def test_node_has_dependents():
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunSpec

    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", task="t"),
            RunSpec(run_id="b", task="t", depends_on=["a"]),
        ]
    )
    assert node_has_dependents(plan, "a")
    assert not node_has_dependents(plan, "b")
