"""Unit tests for run_redirect salvage (热续写门槛) + cancel terminal honesty."""

from agentcore.llm.provider.protocol import LLMMessage, TokenUsage, ToolCall, ToolCallFunction
from agentcore.runtime.runs.salvage import (
    cancelled_state_from_salvage,
    freeze_partial_transcript,
    is_continuable_transcript,
    try_salvage_session,
)
from agentcore.runtime.runs.types import RunPhase, RunSpec


def _spec() -> RunSpec:
    return RunSpec(run_id="r1", task="调研", role="研究员", agent_id="r1", agent_name="研究员")


def _escalate_msg(call_id: str, question: str) -> LLMMessage:
    return LLMMessage(
        role="assistant",
        content=None,
        tool_calls=[
            ToolCall(
                id=call_id,
                function=ToolCallFunction(
                    name="escalate",
                    arguments=(
                        f'{{"question": "{question}", '
                        f'"assumption": "暂用默认", "blocking": false}}'
                    ),
                ),
            )
        ],
    )


def test_empty_opening_is_not_continuable():
    msgs = [
        LLMMessage(role="system", content="you are a researcher"),
        LLMMessage(role="user", content="请调研"),
    ]
    assert is_continuable_transcript(msgs) is False
    assert try_salvage_session(spec=_spec(), messages=msgs) is None


def test_assistant_draft_is_continuable():
    msgs = [
        LLMMessage(role="system", content="sys"),
        LLMMessage(role="user", content="task"),
        LLMMessage(role="assistant", content="半成品草稿……"),
    ]
    assert is_continuable_transcript(msgs) is True
    session = try_salvage_session(spec=_spec(), messages=msgs)
    assert session is not None
    assert session.partial is True
    assert session.content == "半成品草稿……"


def test_completed_tool_turn_is_continuable():
    msgs = [
        LLMMessage(role="user", content="task"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(id="c1", function=ToolCallFunction(name="web_search", arguments="{}"))
            ],
        ),
        LLMMessage(role="tool", content="result", tool_call_id="c1"),
    ]
    assert is_continuable_transcript(msgs) is True
    assert try_salvage_session(spec=_spec(), messages=msgs) is not None


def test_incomplete_tool_call_is_truncated():
    msgs = [
        LLMMessage(role="user", content="task"),
        LLMMessage(role="assistant", content="先搜一下"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(id="c1", function=ToolCallFunction(name="web_search", arguments="{}"))
            ],
        ),
    ]
    frozen = freeze_partial_transcript(msgs)
    assert frozen[-1].role == "assistant"
    assert frozen[-1].content == "先搜一下"
    assert is_continuable_transcript(frozen) is True


def test_none_messages_cannot_salvage():
    assert try_salvage_session(spec=_spec(), messages=None) is None
    assert try_salvage_session(spec=_spec(), messages=[]) is None


def test_cancelled_state_harvests_escalations_and_usage():
    """cancel_worker terminal must keep escalate + tokens (not an empty CANCELLED shell)."""
    msgs = [
        LLMMessage(role="user", content="task"),
        _escalate_msg("c1", "Postgres 还是 MySQL?"),
        LLMMessage(role="tool", content="已记录", tool_call_id="c1"),
        _escalate_msg("c2", "目标受众是谁?"),
        LLMMessage(role="tool", content="已记录", tool_call_id="c2"),
        LLMMessage(role="assistant", content="半成品……"),
    ]
    session = try_salvage_session(spec=_spec(), messages=msgs)
    assert session is not None
    state = cancelled_state_from_salvage(
        session,
        error="redirected",
        usage=TokenUsage(input_tokens=12_000, output_tokens=400, cache_miss_tokens=12_000),
        model="deepseek-v4-flash",
        rounds=2,
    )
    assert state.phase is RunPhase.CANCELLED
    assert state.error == "redirected"
    assert len(state.escalations) == 2
    assert state.escalations[0]["question"] == "Postgres 还是 MySQL?"
    assert state.escalations[1]["question"] == "目标受众是谁?"
    assert state.usage["input"] == 12_000
    assert state.usage["output"] == 400
    assert state.cost  # priced once onto the CANCELLED state
    assert state.rounds == 2
    assert state.transcript


def test_cancelled_state_without_session_still_bills_usage():
    """Usage may exist even when the hot-salvage gate fails (empty / opening-only)."""
    state = cancelled_state_from_salvage(
        None,
        error="redirected",
        usage=TokenUsage(input_tokens=500, output_tokens=10, cache_miss_tokens=500),
        model="deepseek-v4-flash",
        rounds=1,
    )
    assert state.phase is RunPhase.CANCELLED
    assert state.escalations == []
    assert state.usage["input"] == 500
    assert state.cost
    assert state.rounds == 1


def test_cancelled_state_without_spend_keeps_empty_usage():
    state = cancelled_state_from_salvage(None, error="redirected")
    assert state.phase is RunPhase.CANCELLED
    assert state.usage == {}
    assert state.cost == {}
    assert state.escalations == []
