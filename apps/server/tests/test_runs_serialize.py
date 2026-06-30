"""RunSession JSON (de)serialization (P3 跨进程落盘).

Pins that a transcript — including a worker's tool-call turns and tool-result
messages — and a RunSpec with nested RunPolicy / RunContract round-trip losslessly,
so a session loaded from the DB replays the exact context for ``continue_run``.
"""

from agentcore.llm.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.journal import completed_from_journal
from agentcore.runtime.runs import RunPlan, RunSession, RunSpec
from agentcore.runtime.runs.serialize import (
    escalations_from_transcript,
    files_touched_from_transcript,
    plan_from_json,
    plan_to_json,
    run_final_fact,
    session_from_row,
    session_to_row,
    spec_from_json,
    spec_to_json,
    state_from_json,
    state_to_json,
    transcript_from_json,
    transcript_to_json,
)
from agentcore.runtime.runs.types import RunContract, RunKind, RunPhase, RunPolicy, RunState


def _assistant_call(call_id: str, name: str, arguments: str) -> LLMMessage:
    return LLMMessage(
        role="assistant",
        content=None,
        tool_calls=[
            ToolCall(id=call_id, function=ToolCallFunction(name=name, arguments=arguments))
        ],
    )


def test_files_touched_from_transcript_collects_produced_paths_in_order():
    transcript = [
        LLMMessage(role="user", content="建站"),
        _assistant_call("c1", "file_write", '{"path": "index.html", "content": "<html>"}'),
        LLMMessage(role="tool", content="已写入", tool_call_id="c1"),
        _assistant_call("c2", "web_search", '{"query": "x"}'),  # non-mutating → ignored
        _assistant_call(
            "c3", "str_replace", '{"path": "index.html", "old_string": "a", "new_string": "b"}'
        ),
        _assistant_call("c4", "file_move", '{"source": "a.txt", "destination": "docs/b.txt"}'),
        LLMMessage(role="assistant", content="完成"),
    ]
    # index.html deduped (write + edit), file_move records its destination, web_search dropped.
    assert files_touched_from_transcript(transcript) == ["index.html", "docs/b.txt"]


def test_files_touched_from_transcript_skips_malformed_and_pathless():
    transcript = [
        _assistant_call("c1", "file_write", "not valid json"),
        _assistant_call("c2", "file_read", '{"path": "x"}'),  # read is not a product
        _assistant_call("c3", "file_write", '{"content": "no path here"}'),
    ]
    assert files_touched_from_transcript(transcript) == []


def test_state_json_round_trips_files_touched():
    state = RunState(phase=RunPhase.COMPLETED, content="x", files_touched=["a.html", "b.css"])
    restored = state_from_json(state_to_json(state))
    assert restored.files_touched == ["a.html", "b.css"]


def test_state_json_round_trips_debrief():
    # 完工交接简报: a seed/resume must carry the worker's harvested debrief so downstream
    # injection / CEO synthesis on a resumed turn read the same author 结论 / 建议下一步.
    state = RunState(
        phase=RunPhase.COMPLETED,
        content="x",
        debrief={"summary": "做完了甲", "next_steps": "接着做乙"},
    )
    restored = state_from_json(state_to_json(state))
    assert restored.debrief == {"summary": "做完了甲", "next_steps": "接着做乙"}


def test_state_json_debrief_defaults_none():
    restored = state_from_json(state_to_json(RunState(phase=RunPhase.COMPLETED, content="x")))
    assert restored.debrief is None


def test_escalations_from_transcript_collects_in_call_order():
    transcript = [
        LLMMessage(role="user", content="做事"),
        _assistant_call(
            "c1",
            "escalate",
            '{"question": "Postgres 还是 MySQL?", "assumption": "暂用 PG", "blocking": true}',
        ),
        LLMMessage(role="tool", content="已记录", tool_call_id="c1"),
        _assistant_call("c2", "web_search", '{"query": "x"}'),  # not an escalation
        _assistant_call("c3", "escalate", '{"question": "目标受众是谁?"}'),
        LLMMessage(role="assistant", content="完成"),
    ]
    out = escalations_from_transcript(transcript)
    assert out == [
        {
            "question": "Postgres 还是 MySQL?",
            "assumption": "暂用 PG",
            "blocking": True,
            "kind": "normal",
            "status": "raised",
            "answer": None,
        },
        {
            "question": "目标受众是谁?",
            "assumption": "",
            "blocking": False,
            "kind": "normal",
            "status": "raised",
            "answer": None,
        },
    ]


def test_escalations_from_transcript_marks_scope_and_dep_kinds():
    # 受监督的波循环: escalate(kind="scope") 职责偏离 and escalate(kind="dep") 依赖缺口
    # (§2.4 卡在缺输入 X) are BOTH harvested with their kind (the WaveScheduler consumes both
    # at the reactive boundary); an unknown kind degrades to "normal", a plain escalate defaults.
    transcript = [
        _assistant_call(
            "c1",
            "escalate",
            '{"question": "真问题是X不是Y", "assumption": "暂按X", "kind": "scope"}',
        ),
        _assistant_call(
            "c2",
            "escalate",
            '{"question": "缺错误返回结构才能写测试", "assumption": "暂按 {code,msg}", "kind": "dep"}',
        ),
        _assistant_call("c3", "escalate", '{"question": "未知档", "kind": "weird"}'),
        _assistant_call("c4", "escalate", '{"question": "普通问题"}'),
    ]
    out = escalations_from_transcript(transcript)
    assert [e["kind"] for e in out] == ["scope", "dep", "normal", "normal"]
    assert out[0]["question"] == "真问题是X不是Y"
    assert out[1]["question"] == "缺错误返回结构才能写测试"


def test_escalations_from_transcript_skips_malformed_and_empty_question():
    transcript = [
        _assistant_call("c1", "escalate", "not valid json"),
        _assistant_call("c2", "escalate", '{"question": "   "}'),  # empty after strip
        _assistant_call("c3", "escalate", '{"assumption": "no question key"}'),
    ]
    assert escalations_from_transcript(transcript) == []


def test_state_json_round_trips_escalations():
    state = RunState(
        phase=RunPhase.COMPLETED,
        content="x",
        escalations=[{"question": "q1", "assumption": "a1", "blocking": True}],
    )
    restored = state_from_json(state_to_json(state))
    assert restored.escalations == [{"question": "q1", "assumption": "a1", "blocking": True}]


def test_state_json_round_trips_scope_consumed_escalation():
    # 受监督的波循环 P5: a scope escalation's ``kind`` AND the scheduler-set ``consumed``
    # flag must survive the seed round-trip, so a re-drive does not re-fire a SCOPE boundary
    # already handled (state_from_json/to_json copy the dicts whole — every key rides).
    state = RunState(
        phase=RunPhase.COMPLETED,
        content="A 的产出",
        escalations=[{"question": "真问题是X", "kind": "scope", "consumed": True}],
    )
    restored = state_from_json(state_to_json(state))
    assert restored.escalations == [{"question": "真问题是X", "kind": "scope", "consumed": True}]


def test_run_final_fact_completed_from_journal_preserves_scope_consumed():
    # 单一事实源 (P5 持久化): a worker's terminal RunState journaled as a message_final fact
    # (run_final_fact) must rebuild — via completed_from_journal — with its scope escalation
    # AND consumed flag intact, the durable twin of the in-memory seed (drive.py re-journals
    # the consumed state at a SCOPE yield so this projection carries it).
    state = RunState(
        phase=RunPhase.COMPLETED,
        content="A 的产出",
        escalations=[{"question": "真问题是X", "kind": "scope", "consumed": True}],
    )
    fact = run_final_fact("a", state)
    entry = {"kind": fact.kind, "payload": fact.payload}
    rebuilt = completed_from_journal([entry])
    assert set(rebuilt) == {"a"}
    assert rebuilt["a"].escalations == [
        {"question": "真问题是X", "kind": "scope", "consumed": True}
    ]


def test_transcript_round_trips_with_tool_calls_and_tool_results():
    transcript = [
        LLMMessage(role="system", content="sys"),
        LLMMessage(role="user", content="做A"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=ToolCallFunction(name="web_search", arguments='{"q":"x"}'),
                )
            ],
        ),
        LLMMessage(role="tool", content="结果…", tool_call_id="call_1"),
        LLMMessage(role="assistant", content="最终产出", reasoning_content="想了想"),
    ]
    restored = transcript_from_json(transcript_to_json(transcript))
    assert len(restored) == 5
    # tool-call turn preserved (content None, one ToolCall with function fields)
    tc_msg = restored[2]
    assert tc_msg.role == "assistant"
    assert tc_msg.content is None
    assert tc_msg.tool_calls[0].id == "call_1"
    assert tc_msg.tool_calls[0].function.name == "web_search"
    assert tc_msg.tool_calls[0].function.arguments == '{"q":"x"}'
    # tool-result turn preserved (role + tool_call_id linkage)
    assert restored[3].role == "tool"
    assert restored[3].tool_call_id == "call_1"
    # final answer + reasoning preserved
    assert restored[4].content == "最终产出"
    assert restored[4].reasoning_content == "想了想"


def test_spec_round_trips_with_nested_policy_and_contract():
    spec = RunSpec(
        run_id="del_abc_1",
        task="做A",
        kind=RunKind.AGENT,
        role="研究员",
        tools=["web_search", "read_url"],
        model_preference="strong",
        policy=RunPolicy(
            result_handling="summarize",
            contract=RunContract(must_contain=["风险"], min_length=100, strict=True),
        ),
    )
    restored = spec_from_json(spec_to_json(spec))
    assert restored.run_id == "del_abc_1"
    assert restored.role == "研究员"
    assert restored.tools == ["web_search", "read_url"]
    # kind coerced back to the enum
    assert restored.kind is RunKind.AGENT
    # nested policy is a real RunPolicy, and its contract a real RunContract — so
    # continue_run's ``spec.policy.contract`` keeps working after a DB round-trip.
    assert isinstance(restored.policy, RunPolicy)
    assert restored.policy.result_handling == "summarize"
    assert isinstance(restored.policy.contract, RunContract)
    assert restored.policy.contract.must_contain == ["风险"]
    assert restored.policy.contract.strict is True


def test_spec_without_contract_round_trips_to_none():
    spec = RunSpec(run_id="r1", task="t", policy=RunPolicy())
    restored = spec_from_json(spec_to_json(spec))
    assert restored.policy.contract is None


def test_plan_json_round_trips_late_bound_placeholder_node():
    # 受监督的波循环 P5 (partial spec 往返): a bind_after_deps node carries a PLACEHOLDER spec
    # (its real role/task land at the BIND boundary via replan). The plan must serialize +
    # rebuild that partial node faithfully — bind_after_deps preserved, placeholders intact,
    # deps wired — so a paused supervised plan rebuilt from its plan_snapshot still knows the
    # node is待定稿 and never dispatches it unbound.
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", task="调研", role="研究员"),
            RunSpec(
                run_id="b",
                task="占位",
                role="待定",
                depends_on=["a"],
                bind_after_deps=True,
            ),
        ]
    )
    restored = plan_from_json(plan_to_json(plan))
    a, b = restored.nodes
    assert (a.run_id, a.bind_after_deps) == ("a", False)
    assert b.run_id == "b"
    assert b.bind_after_deps is True  # the late-bind marker survives → still待定稿
    assert (b.role, b.task) == ("待定", "占位")  # placeholders intact
    assert b.depends_on == ["a"]


def test_spec_from_json_tolerates_unknown_and_missing_keys():
    # A row written by a different build (extra key) / missing an optional must still
    # load — _filtered drops unknowns, dataclass defaults fill the gaps.
    raw = {"run_id": "r1", "task": "t", "surprise_field": 1, "policy": {"ghost": 2}}
    spec = spec_from_json(raw)
    assert spec.run_id == "r1"
    assert spec.task == "t"
    assert isinstance(spec.policy, RunPolicy)


def test_session_row_round_trip():
    spec = RunSpec(run_id="del_x_1", task="t", role="A", policy=RunPolicy())
    session = RunSession(
        run_id="del_x_1",
        spec=spec,
        transcript=[LLMMessage(role="assistant", content="v1")],
        content="v1",
        recall_count=2,
    )
    row = session_to_row(session)
    assert row["run_id"] == "del_x_1"
    assert row["recall_count"] == 2
    assert row["content"] == "v1"
    assert isinstance(row["transcript"], list)
    assert isinstance(row["spec"], dict)

    # session_from_row reads attribute access (like the ORM row), so wrap in a shim.
    class _Row:
        run_id = row["run_id"]
        spec = row["spec"]
        transcript = row["transcript"]
        content = row["content"]
        recall_count = row["recall_count"]

    back = session_from_row(_Row())
    assert back.run_id == "del_x_1"
    assert back.recall_count == 2
    assert back.content == "v1"
    assert back.transcript[0].content == "v1"
    assert back.spec.role == "A"
