"""Unit tests for diagnostic LLM window wire projection."""

from agentcore.runtime.facts import (
    LlmCallFact,
    RoundBoundaryFact,
    ToolCallFact,
    TurnStartedFact,
)
from agentcore.runtime.journal.window_wire import project_run_llm_window


def test_project_run_llm_window_folds_captain_tool_round():
    run_id = "cap"
    entries = [
        TurnStartedFact(
            system_prompt="SYS",
            user_message="go",
            model_profile="chat",
            history_len=0,
        )
        .to_fact()
        .entry(),
        RoundBoundaryFact(round_idx=0, run_id=run_id, role="captain").to_fact().entry(),
        LlmCallFact(
            run_id=run_id,
            round_idx=0,
            tool_calls=[
                {
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{}"},
                }
            ],
            finish_reason="tool_calls",
        )
        .to_fact()
        .entry(),
        ToolCallFact(
            run_id=run_id,
            tool_call_id="c1",
            name="search",
            arguments="{}",
            result="hit",
            success=True,
        )
        .to_fact()
        .entry(),
    ]
    resp = project_run_llm_window(entries, run_id=run_id)
    assert resp.available is True
    assert [m.role for m in resp.messages] == ["system", "user", "assistant", "tool"]
    assert resp.messages[2].tool_calls[0].function.name == "search"
    assert resp.messages[3].content == "hit"


def test_project_run_llm_window_unavailable_without_turn_started():
    resp = project_run_llm_window(
        [{"kind": "turn_end", "payload": {"finish_reason": "end_turn"}}],
        run_id="cap",
    )
    assert resp.available is False
    assert resp.messages == []
