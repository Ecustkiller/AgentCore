"""RunSession JSON (de)serialization (P3 跨进程落盘).

Pins that a transcript — including a worker's tool-call turns and tool-result
messages — and a RunSpec with nested RunPolicy / RunContract round-trip losslessly,
so a session loaded from the DB replays the exact context for ``continue_run``.
"""

from agentcore.llm.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.runs import RunSession, RunSpec
from agentcore.runtime.runs.serialize import (
    escalations_from_transcript,
    files_touched_from_transcript,
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
        tool_calls=[ToolCall(id=call_id, function=ToolCallFunction(name=name, arguments=arguments))],
    )


def test_files_touched_from_transcript_collects_produced_paths_in_order():
    transcript = [
        LLMMessage(role="user", content="建站"),
        _assistant_call("c1", "file_write", '{"path": "index.html", "content": "<html>"}'),
        LLMMessage(role="tool", content="已写入", tool_call_id="c1"),
        _assistant_call("c2", "web_search", '{"query": "x"}'),  # non-mutating → ignored
        _assistant_call("c3", "str_replace", '{"path": "index.html", "old_string": "a", "new_string": "b"}'),
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
        {"question": "Postgres 还是 MySQL?", "assumption": "暂用 PG", "blocking": True},
        {"question": "目标受众是谁?", "assumption": "", "blocking": False},
    ]


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
