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


# --- 辩论/审查 呈现标记 (前端UX目标态 §四: stance/group, display-only) -----------


def test_stance_and_group_parsed_onto_spec():
    plan, _ = build_run_plan(
        [
            {"role": "正方", "task": "支持", "stance": "pro", "group": "g1"},
            {"role": "反方", "task": "反对", "stance": "con", "group": "g1"},
        ],
        id_prefix="t",
    )
    a, b = plan.nodes
    assert (a.stance, a.group) == ("pro", "g1")
    assert (b.stance, b.group) == ("con", "g1")


def test_invalid_stance_dropped():
    # Lenient like tier/effort: an unknown side leaves no tag (no debate signal).
    plan, _ = build_run_plan(
        [{"role": "A", "task": "a", "stance": "maybe"}], id_prefix="t"
    )
    assert plan.nodes[0].stance == ""


def test_group_trimmed_and_tags_default_blank():
    plan, _ = build_run_plan(
        [
            {"role": "A", "task": "a", "stance": "pro", "group": "  g  "},
            {"role": "B", "task": "b"},
        ],
        id_prefix="t",
    )
    assert plan.nodes[0].group == "g"
    # An ordinary task carries no tags (守住「形状是数据不是模式」: a debate is just
    # 普通并行 + a presentation hint, so an untagged batch is byte-identical to before).
    assert plan.nodes[1].stance == "" and plan.nodes[1].group == ""


def test_stance_parsed_on_dag_step():
    tasks = [
        {"id": "s1", "role": "正方", "task": "支持", "stance": "pro"},
        {"id": "s2", "role": "反方", "task": "反对", "stance": "con", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert errs == []
    assert plan.by_id("t_s1").stance == "pro"
    assert plan.by_id("t_s2").stance == "con"


def test_round_parsed_onto_spec():
    # 真·多轮辩论 (前端UX目标态 §四): round 标轮次, display-only, 与 stance/group 正交.
    plan, _ = build_run_plan(
        [
            {"role": "正方", "task": "r1", "stance": "pro", "round": 1},
            {"role": "正方", "task": "r2", "stance": "pro", "round": 2},
        ],
        id_prefix="t",
    )
    a, b = plan.nodes
    assert a.round == 1
    assert b.round == 2


def test_invalid_round_dropped():
    # Lenient like stance: 非正整数 / 非 int / None 都落 0 (无多轮信号). bool 尤其要挡——
    # True 是 int 子类, 不可被当成「第 1 轮」.
    plan, _ = build_run_plan(
        [
            {"role": "A", "task": "zero", "round": 0},
            {"role": "B", "task": "neg", "round": -2},
            {"role": "C", "task": "str", "round": "2"},
            {"role": "D", "task": "boolean", "round": True},
            {"role": "E", "task": "none"},
        ],
        id_prefix="t",
    )
    assert [n.round for n in plan.nodes] == [0, 0, 0, 0, 0]


# --- 结构化挂起 2a (checkpoint_after, 计划期挂起标记) -------------------------------


def test_checkpoint_after_parsed_onto_spec():
    # 计划期挂起标记: 宽松读取 (bool(...)), WaveScheduler 据此在节点后波间挂起.
    plan, _ = build_run_plan(
        [
            {"role": "A", "task": "a", "checkpoint_after": True},
            {"role": "B", "task": "b"},
        ],
        id_prefix="t",
    )
    # An untagged node defaults False, so a plan with no checkpoint is byte-identical.
    assert plan.nodes[0].checkpoint_after is True
    assert plan.nodes[1].checkpoint_after is False


def test_checkpoint_after_parsed_on_dag_step():
    tasks = [
        {"id": "s1", "role": "A", "task": "a", "checkpoint_after": True},
        {"id": "s2", "role": "B", "task": "b", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t")
    assert errs == []
    assert plan.by_id("t_s1").checkpoint_after is True
    assert plan.by_id("t_s2").checkpoint_after is False


def test_checkpoint_after_truthy_coerced():
    # Lenient like the other flags: any falsy value (missing / 0 / "") → False.
    plan, _ = build_run_plan(
        [
            {"role": "A", "task": "a", "checkpoint_after": 0},
            {"role": "B", "task": "b", "checkpoint_after": ""},
        ],
        id_prefix="t",
    )
    assert plan.nodes[0].checkpoint_after is False
    assert plan.nodes[1].checkpoint_after is False


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


# --- 阶段2 嵌套子任务: tree-position stamping + can_delegate opt-in -------------


def test_defaults_top_level_depth_one_parent_none_no_delegate():
    # The common caller (CEO delegate) makes depth-1 workers parented to the root;
    # absent an explicit can_delegate they are leaf workers.
    plan, _ = build_run_plan([{"role": "A", "task": "a"}], id_prefix="t")
    n = plan.nodes[0]
    assert n.depth == 1
    assert n.parent_run_id is None
    assert n.can_delegate is False


def test_stamps_parent_and_depth_on_flat_batch():
    plan, _ = build_run_plan(
        [{"role": "A", "task": "a"}, {"role": "B", "task": "b"}],
        id_prefix="t",
        parent_run_id="cap",
        depth=2,
    )
    assert all(n.parent_run_id == "cap" and n.depth == 2 for n in plan.nodes)


def test_stamps_parent_and_depth_on_dag_batch():
    tasks = [
        {"id": "s1", "role": "A", "task": "a"},
        {"id": "s2", "role": "B", "task": "b", "depends_on": ["s1"]},
    ]
    plan, errs = build_run_plan(tasks, id_prefix="t", parent_run_id="cap", depth=2)
    assert errs == []
    assert all(n.parent_run_id == "cap" and n.depth == 2 for n in plan.nodes)


def test_can_delegate_opt_in_parsed_per_task():
    plan, _ = build_run_plan(
        [
            {"role": "队长", "task": "a", "can_delegate": True},
            {"role": "助手", "task": "b"},
        ],
        id_prefix="t",
    )
    assert plan.nodes[0].can_delegate is True
    assert plan.nodes[1].can_delegate is False
