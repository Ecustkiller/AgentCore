"""拆·playbook 固化 (§2.1) — the playbook registry + expansion.

Covers each固化形状's slot validation + emitted DAG shape, the registry's reject paths
(unknown name / bad args / missing required slot), and — most importantly — that every
expanded ``tasks`` list is actually runnable: it round-trips through the REAL
``build_run_plan`` with no errors, so an emitted id / depends_on mismatch can't slip through.
"""

from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.playbooks import (
    PLAYBOOKS,
    available_playbooks,
    expand_playbook,
)


def _roles(tasks: list[dict]) -> list[str]:
    return [t["role"] for t in tasks]


def _by_id(tasks: list[dict]) -> dict[str, dict]:
    return {t["id"]: t for t in tasks}


# ── research_report ───────────────────────────────────────────────────────────


def test_research_report_fans_out_one_researcher_per_angle_then_outline_then_write():
    tasks, errors = expand_playbook(
        "research_report",
        {"topic": "向量数据库", "angles": ["原理", "选型", "成本"], "checkpoint": True},
    )
    assert errors == []
    by_id = _by_id(tasks)
    # one 调研员 per angle, then 提纲(依赖全部调研), then 写作(依赖提纲).
    research_ids = [f"research_{i}" for i in range(3)]
    assert all(rid in by_id for rid in research_ids)
    assert set(by_id["outline"]["depends_on"]) == set(research_ids)
    assert by_id["write"]["depends_on"] == ["outline"]
    # checkpoint flag rides the 提纲 step (成纲后写作前过目); the write step requires file landing.
    assert by_id["outline"]["checkpoint_after"] is True
    assert by_id["write"]["contract"]["requires_files"] is True
    # each angle is named into its researcher's task so the fan-out doesn't run blind/overlapping.
    assert "选型" in by_id["research_1"]["task"]


def test_research_report_without_angles_uses_single_researcher():
    tasks, errors = expand_playbook("research_report", {"topic": "X"})
    assert errors == []
    by_id = _by_id(tasks)
    assert by_id["outline"]["depends_on"] == ["research_0"]
    assert by_id["outline"]["checkpoint_after"] is False  # default: no checkpoint


def test_research_report_requires_topic():
    tasks, errors = expand_playbook("research_report", {})
    assert tasks == []
    assert errors and "topic" in errors[0]


def test_research_report_caps_angle_fanout():
    from agentcore.runtime.runs.playbooks import MAX_PLAYBOOK_FANOUT

    tasks, errors = expand_playbook(
        "research_report", {"topic": "X", "angles": [f"a{i}" for i in range(MAX_PLAYBOOK_FANOUT + 5)]}
    )
    assert errors == []
    researchers = [t for t in tasks if t["role"] == "调研员"]
    assert len(researchers) == MAX_PLAYBOOK_FANOUT


# ── build_feature ─────────────────────────────────────────────────────────────


def test_build_feature_defaults_to_api_plus_parallel_ui_and_test():
    tasks, errors = expand_playbook("build_feature", {"feature": "用户登录", "stack": "FastAPI+React"})
    assert errors == []
    by_id = _by_id(tasks)
    assert set(by_id) == {"api", "ui", "test"}
    # ui & test both fan out from api (share its dep set → parallel siblings on the same seam).
    assert by_id["ui"]["depends_on"] == ["api"]
    assert by_id["test"]["depends_on"] == ["api"]
    # the api task tells the worker to broadcast its interface contract on the note wall (4b 对账 hook).
    assert "post_note" in by_id["api"]["task"]
    assert "FastAPI+React" in by_id["api"]["task"]


def test_build_feature_include_filters_steps():
    tasks, _ = expand_playbook("build_feature", {"feature": "X", "include": ["ui"]})
    assert set(_by_id(tasks)) == {"api", "ui"}
    tasks, _ = expand_playbook("build_feature", {"feature": "X", "include": ["test"]})
    assert set(_by_id(tasks)) == {"api", "test"}


def test_build_feature_requires_feature():
    tasks, errors = expand_playbook("build_feature", {})
    assert tasks == []
    assert errors and "feature" in errors[0]


# ── compare_options ───────────────────────────────────────────────────────────


def test_compare_options_evaluates_each_then_summarises():
    tasks, errors = expand_playbook(
        "compare_options",
        {"question": "选 Postgres 还是 MySQL", "options": ["Postgres", "MySQL"], "criteria": ["性能", "生态"]},
    )
    assert errors == []
    by_id = _by_id(tasks)
    assert {"eval_0", "eval_1", "summary"} == set(by_id)
    assert set(by_id["summary"]["depends_on"]) == {"eval_0", "eval_1"}
    # each evaluator is pinned to ONE option and carries the criteria.
    assert "Postgres" in by_id["eval_0"]["task"] and "性能" in by_id["eval_0"]["task"]


def test_compare_options_requires_question_and_two_options():
    _, errors = expand_playbook("compare_options", {"options": ["only-one"]})
    joined = "；".join(errors)
    assert "question" in joined and "options" in joined


# ── registry reject paths ─────────────────────────────────────────────────────


def test_expand_unknown_playbook_lists_available():
    tasks, errors = expand_playbook("nope", {})
    assert tasks == []
    assert errors and "未知 playbook" in errors[0]
    for name in PLAYBOOKS:
        assert name in errors[0]


def test_expand_rejects_non_object_args():
    tasks, errors = expand_playbook("research_report", ["not", "a", "dict"])  # type: ignore[arg-type]
    assert tasks == []
    assert errors and "playbook_args" in errors[0]


def test_available_playbooks_lists_all_three():
    listing = available_playbooks()
    assert set(PLAYBOOKS) == {"research_report", "build_feature", "compare_options"}
    for name in PLAYBOOKS:
        assert name in listing


# ── every expansion is a runnable plan (the real builder, not a mock) ──────────


def test_every_playbook_expansion_builds_a_valid_run_plan():
    samples = {
        "research_report": {"topic": "T", "angles": ["a", "b"], "checkpoint": True},
        "build_feature": {"feature": "F", "stack": "S"},
        "compare_options": {"question": "Q", "options": ["A", "B", "C"]},
    }
    expected_nodes = {"research_report": 4, "build_feature": 3, "compare_options": 4}
    for name, args in samples.items():
        tasks, errors = expand_playbook(name, args)
        assert errors == [], name
        plan, plan_errors = build_run_plan(tasks, id_prefix=f"pb_{name}")
        assert plan_errors == [], (name, plan_errors)
        assert len(plan.nodes) == expected_nodes[name], name
        # waves() raises on a cycle / dangling edge — a clean call proves the DAG is sound.
        assert plan.waves()
