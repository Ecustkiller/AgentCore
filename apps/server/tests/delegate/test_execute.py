"""Basic delegate execute, validation, events, and schema tests."""

from agentcore.core.types import ToolEffect
from agentcore.llm.protocol import TokenUsage
from agentcore.runtime.events import EventSink, EventType
from tests.delegate.conftest import Provider, ctx, tool


async def test_parallel_delegate_returns_products_non_terminal():
    t = tool(Provider(["AOUT", "BOUT"]))
    result = await t.execute(
        {"tasks": [{"role": "研究员", "task": "做A"}, {"role": "写手", "task": "做B"}]}, ctx()
    )
    assert result.success is True
    assert result.is_terminal is False
    assert "AOUT" in result.output
    assert "BOUT" in result.output
    assert "研究员" in result.output
    assert "写手" in result.output
    assert set(result.metadata) == {
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cache_hit_tokens",
        "cache_miss_tokens",
    }


async def test_dag_delegate_completes_with_both_products():
    tasks = [
        {"id": "s1", "role": "研究员", "task": "调研"},
        {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    ]
    t = tool(Provider(["UPSTREAM", "FINAL"]))
    result = await t.execute({"tasks": tasks}, ctx())
    assert result.success is True
    assert result.is_terminal is False
    assert "UPSTREAM" in result.output
    assert "FINAL" in result.output


async def test_finalize_single_worker_surfaces_directly_as_terminal():
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        reasoning_tokens=0,
        cache_hit_tokens=6,
        cache_miss_tokens=4,
    )
    sink = EventSink()
    t = tool(Provider(["DIRECT"], usage=usage), sink=sink)
    result = await t.execute(
        {"tasks": [{"role": "工程师", "task": "建文件"}], "finalize": True}, ctx()
    )
    assert result.success is True
    assert result.is_terminal is True
    assert result.effect is ToolEffect.HANDOFF
    assert result.final_text == "DIRECT"
    assert t.usage["input"] == 10
    assert "input_tokens" not in result.metadata
    sink.close()
    deltas = [e.payload["delta"] async for e in sink if e.type == EventType.CONTENT_DELTA]
    assert deltas == ["DIRECT"]


async def test_finalize_ignored_for_multi_worker_batch():
    t = tool(Provider(["A", "B"]))
    result = await t.execute(
        {
            "tasks": [{"role": "A", "task": "a"}, {"role": "B", "task": "b"}],
            "finalize": True,
        },
        ctx(),
    )
    assert result.is_terminal is False
    assert "A" in result.output and "B" in result.output


async def test_finalize_falls_back_to_synthesis_when_worker_fails():
    t = tool(Provider(["X"]))
    result = await t.execute(
        {
            "tasks": [
                {
                    "role": "A",
                    "task": "a",
                    "contract": {"min_length": 100, "strict": True},
                }
            ],
            "finalize": True,
        },
        ctx(),
    )
    assert result.is_terminal is False


async def test_empty_tasks_rejected():
    t = tool(Provider([]))
    result = await t.execute({"tasks": []}, ctx())
    assert result.success is False
    assert result.is_terminal is False
    assert result.error


async def test_all_invalid_tasks_rejected():
    t = tool(Provider([]))
    result = await t.execute({"tasks": [{"role": "A"}]}, ctx())
    assert result.success is False
    assert result.error


async def test_worker_usage_accumulates_across_calls():
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        reasoning_tokens=2,
        cache_hit_tokens=6,
        cache_miss_tokens=4,
    )
    t = tool(Provider(["X", "Y", "Z", "W"], usage=usage))
    first = await t.execute({"tasks": [{"role": "A", "task": "a"}]}, ctx())
    assert first.metadata["input_tokens"] == 10
    assert first.metadata["cache_hit_tokens"] == 6
    assert t.usage == {
        "input": 10,
        "output": 5,
        "reasoning": 2,
        "cache_hit": 6,
        "cache_miss": 4,
    }
    await t.execute({"tasks": [{"role": "B", "task": "b"}]}, ctx())
    assert t.usage == {
        "input": 20,
        "output": 10,
        "reasoning": 4,
        "cache_hit": 12,
        "cache_miss": 8,
    }


async def test_emits_plan_and_lifecycle_events():
    sink = EventSink()
    t = tool(Provider(["X"]), sink=sink)
    await t.execute({"tasks": [{"role": "A", "task": "做A"}]}, ctx())
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.RUN_PLAN in types
    assert EventType.RUN_STARTED in types
    assert EventType.RUN_COMPLETED in types
    assert EventType.RUN_PROGRESS in types


async def test_run_plan_carries_stance_and_group_tags():
    sink = EventSink()
    t = tool(Provider(["PRO", "CON"]), sink=sink)
    await t.execute(
        {
            "tasks": [
                {"role": "正方", "task": "支持", "stance": "pro", "group": "g1"},
                {"role": "反方", "task": "反对", "stance": "con", "group": "g1"},
            ]
        },
        ctx(),
    )
    sink.close()
    plan_runs = [r async for e in sink if e.type == EventType.RUN_PLAN for r in e.payload["runs"]]
    by_task = {r["task"]: r for r in plan_runs}
    assert by_task["支持"]["stance"] == "pro"
    assert by_task["支持"]["group"] == "g1"
    assert by_task["反对"]["stance"] == "con"
    assert by_task["反对"]["group"] == "g1"


async def test_run_plan_carries_round_tag():
    sink = EventSink()
    t = tool(Provider(["R1", "R2"]), sink=sink)
    await t.execute(
        {
            "tasks": [
                {"id": "p1", "role": "正方", "task": "首轮", "stance": "pro", "round": 1},
                {
                    "id": "p2",
                    "role": "正方",
                    "task": "次轮",
                    "stance": "pro",
                    "round": 2,
                    "depends_on": ["p1"],
                },
            ]
        },
        ctx(),
    )
    sink.close()
    plan_runs = [r async for e in sink if e.type == EventType.RUN_PLAN for r in e.payload["runs"]]
    by_task = {r["task"]: r for r in plan_runs}
    assert by_task["首轮"]["round"] == 1
    assert by_task["次轮"]["round"] == 2


async def test_run_plan_omits_tags_for_ordinary_batch():
    sink = EventSink()
    t = tool(Provider(["X", "Y"]), sink=sink)
    await t.execute({"tasks": [{"role": "A", "task": "a"}, {"role": "B", "task": "b"}]}, ctx())
    sink.close()
    plan_runs = [r async for e in sink if e.type == EventType.RUN_PLAN for r in e.payload["runs"]]
    assert plan_runs
    assert all("stance" not in r and "group" not in r and "round" not in r for r in plan_runs)


def test_task_description_matches_what_worker_actually_receives():
    t = tool(Provider([]))
    task_desc = t.schema.parameters["properties"]["tasks"]["items"]["properties"]["task"][
        "description"
    ]
    assert "原始用户请求" in task_desc
    assert "只收到这段" not in task_desc


async def test_playbook_instantiates_whole_team_and_runs():
    # 拆·playbook 固化 (§2.1): naming a固化形状 + slots expands to a full team and flows through the
    # SAME pipeline as a hand-written tasks array (compare_options → 2 evaluators + 1 summary).
    t = tool(Provider([]))
    result = await t.execute(
        {"playbook": "compare_options", "playbook_args": {"question": "选 A 还是 B", "options": ["A", "B"]}},
        ctx(),
    )
    assert result.success is True
    assert result.is_terminal is False
    assert "汇总分析师" in result.output  # the summary role the playbook minted


async def test_playbook_unknown_name_rejected():
    t = tool(Provider([]))
    result = await t.execute({"playbook": "does_not_exist"}, ctx())
    assert result.success is False
    assert "未知 playbook" in (result.error or "")


async def test_playbook_missing_required_slot_rejected():
    t = tool(Provider([]))
    result = await t.execute({"playbook": "research_report", "playbook_args": {}}, ctx())
    assert result.success is False
    assert "topic" in (result.error or "")


async def test_playbook_and_tasks_are_mutually_exclusive():
    t = tool(Provider([]))
    result = await t.execute(
        {
            "playbook": "research_report",
            "playbook_args": {"topic": "X"},
            "tasks": [{"role": "a", "task": "b"}],
        },
        ctx(),
    )
    assert result.success is False
    assert "二选一" in (result.error or "")


def test_schema_exposes_playbook_params_and_relaxes_required():
    t = tool(Provider([]))
    params = t.schema.parameters
    props = params["properties"]
    assert set(props["playbook"]["enum"]) == {"research_report", "build_feature", "compare_options"}
    assert "playbook_args" in props
    # tasks is no longer HARD-required (playbook is an alternative entry); runtime enforces XOR.
    assert "tasks" not in params.get("required", [])


def test_strict_description_separates_rework_from_disposition():
    t = tool(Provider([]))
    contract_props = t.schema.parameters["properties"]["tasks"]["items"]["properties"]["contract"]
    strict_desc = contract_props["properties"]["strict"]["description"]
    assert "硬退" in strict_desc
    assert "软" in strict_desc
    assert "必须返工" not in strict_desc
    contract_desc = contract_props["description"]
    assert "自动返工一次" in contract_desc
    assert "硬退" in contract_desc
