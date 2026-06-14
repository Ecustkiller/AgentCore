"""Tests for build_run_plan: raw delegate args → RunPlan (第一阶段内联角色版).

Covers the single/parallel/DAG shape inference, run-id minting (flat numbering vs
DAG namespacing + edge rewrite), inline-role field mapping, the fan-out sibling
summary, the tool allow-list filter, knob validation, and the reject-on-error /
reject-when-none-valid contract.
"""

from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.types import RunKind


def test_single_task_one_node():
    plan, errs = build_run_plan([{"role": "研究员", "task": "调研X"}], id_prefix="t")
    assert errs == []
    assert len(plan.nodes) == 1
    n = plan.nodes[0]
    assert n.run_id == "t_1"
    assert n.agent_id == "t_1"
    assert n.agent_name == "研究员"
    assert n.role == "研究员"
    assert n.task == "调研X"
    assert n.depends_on == []
    assert n.kind is RunKind.AGENT
    assert n.sibling_summary == ""


def test_parallel_batch_sets_sibling_summary():
    plan, errs = build_run_plan(
        [{"role": "A", "task": "做A"}, {"role": "B", "task": "做B"}], id_prefix="t"
    )
    assert errs == []
    a, b = plan.nodes
    assert (a.run_id, b.run_id) == ("t_1", "t_2")
    assert "B" in a.sibling_summary and "做B" in a.sibling_summary
    assert "A" in b.sibling_summary and "做A" in b.sibling_summary
    assert len(plan.waves()) == 1


def test_counter_start_offsets_ids():
    plan, _ = build_run_plan([{"role": "A", "task": "a"}], id_prefix="t", counter_start=5)
    assert plan.nodes[0].run_id == "t_6"


def test_dag_namespaces_ids_and_rewrites_edges():
    tasks = [
        {"id": "s1", "role": "A", "task": "a"},
        {"id": "s2", "role": "B", "task": "b", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert errs == []
    assert [n.run_id for n in plan.nodes] == ["t_s1", "t_s2"]
    assert plan.nodes[1].depends_on == ["t_s1"]
    assert [[n.run_id for n in w] for w in plan.waves()] == [["t_s1"], ["t_s2"]]


def test_empty_tasks_is_error():
    plan, errs = build_run_plan([])
    assert errs
    assert not plan.nodes


def test_all_invalid_flat_is_error():
    # First item lacks task, second lacks role → no valid flat node.
    plan, errs = build_run_plan([{"role": "A"}, {"task": "x"}], id_prefix="t")
    assert errs
    assert not plan.nodes


def test_dag_missing_role_collects_error():
    tasks = [
        {"id": "s1", "task": "a"},
        {"id": "s2", "role": "B", "task": "b", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert any("s1" in e for e in errs)


def test_dag_cycle_is_error():
    tasks = [
        {"id": "s1", "role": "A", "task": "a", "depends_on": ["s2"]},
        {"id": "s2", "role": "B", "task": "b", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert errs
    assert any("cycle" in e for e in errs)


def test_tools_filtered_by_allowlist():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "a", "tools": ["web_search", "ghost"]}],
        id_prefix="t",
        valid_tools={"web_search"},
    )
    assert plan.nodes[0].tools == ["web_search"]


def test_invalid_model_preference_falls_back_to_strong():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "a", "model_preference": "ultra"}], id_prefix="t"
    )
    assert plan.nodes[0].model_preference == "strong"


def test_invalid_reasoning_effort_cleared():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "a", "reasoning_effort": "turbo"}], id_prefix="t"
    )
    assert plan.nodes[0].reasoning_effort is None


def test_dag_invalid_on_failure_falls_back_to_degrade():
    tasks = [
        {"id": "s1", "role": "A", "task": "a"},
        {"id": "s2", "role": "B", "task": "b", "depends_on": ["s1"], "on_failure": "explode"},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert errs == []
    assert plan.by_id("t_s2").policy.on_failure == "degrade"


def test_contract_parsed_onto_policy():
    plan, _ = build_run_plan(
        [
            {
                "role": "A",
                "task": "a",
                "contract": {
                    "required_sections": ["结论", "  "],  # blank dropped
                    "must_contain": ["风险"],
                    "min_length": 100,
                    "output_format": "json",
                    "strict": True,
                },
            }
        ],
        id_prefix="t",
    )
    c = plan.nodes[0].policy.contract
    assert c is not None
    assert c.required_sections == ["结论"]
    assert c.must_contain == ["风险"]
    assert c.min_length == 100
    assert c.output_format == "json"
    assert c.strict is True


def test_no_contract_leaves_policy_contract_none():
    plan, _ = build_run_plan([{"role": "A", "task": "a"}], id_prefix="t")
    assert plan.nodes[0].policy.contract is None


def test_contract_block_with_no_rule_is_none():
    # strict alone declares no enforceable rule → None (baseline still applies).
    plan, _ = build_run_plan(
        [{"role": "A", "task": "a", "contract": {"strict": True}}], id_prefix="t"
    )
    assert plan.nodes[0].policy.contract is None


def test_dag_step_contract_parsed_independently():
    tasks = [
        {"id": "s1", "role": "A", "task": "a", "contract": {"min_length": 50}},
        {"id": "s2", "role": "B", "task": "b", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert errs == []
    assert plan.by_id("t_s1").policy.contract.min_length == 50
    assert plan.by_id("t_s2").policy.contract is None


def test_contract_invalid_output_format_falls_back_to_text():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "a", "contract": {"output_format": "xml", "min_length": 10}}],
        id_prefix="t",
    )
    assert plan.nodes[0].policy.contract.output_format == "text"
