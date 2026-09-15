"""Pause-to-ask is exclusive: at most one ``ask_user`` per model round.

Other tools in that round may run first; two asks still fail closed. Resume
continues after that one answer. Legacy parallel-ask journals must not
re-freeze without a card (no skip placeholder, no sibling walker).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from agentcore.core.types import ToolEffect
from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.facts import (
    FactKind,
    LlmCallFact,
    RoundBoundaryFact,
    TurnFactLog,
    TurnStartedFact,
    current_fact_log,
)
from agentcore.runtime.pipeline.resume.recover_path import ResumeOpenToolCallsError
from agentcore.runtime.pipeline.resume.settle import (
    append_resumed_tool_results,
    persist_resumed_tool_results,
    unclosed_tool_call_ids,
)
from agentcore.runtime.suspension import AskUserSuspension, captain_transcript
from agentcore.runtime.suspension.capture import persist_suspension_capture


def _one_ask() -> list[ToolCall]:
    return [
        ToolCall(
            id="ask_a",
            function=ToolCallFunction(
                name="ask_user", arguments='{"message":"先确认范围？"}'
            ),
        ),
    ]


def _two_asks() -> list[ToolCall]:
    return [
        *_one_ask(),
        ToolCall(
            id="ask_b",
            function=ToolCallFunction(
                name="ask_user", arguments='{"message":"区外目录写入授权"}'
            ),
        ),
    ]


def _frame(*, tool_calls: list[ToolCall] | None = None) -> AskUserSuspension:
    calls = tool_calls if tool_calls is not None else _one_ask()
    return AskUserSuspension(
        message_id="msg-1",
        conversation_id="conv-1",
        user_id="user-1",
        captain_run_id="cap",
        checkpoint_id="cp-a",
        tool_call_id="ask_a",
        base_system_prompt="sys",
        user_message="hello",
        question="先确认范围？",
        transcript=[LLMMessage(role="assistant", content=None, tool_calls=calls)],
        journal_entries=[
            {
                "kind": "checkpoint_required",
                "payload": {
                    "checkpoint_id": "cp-a",
                    "question": "先确认范围？",
                    "questions": [],
                },
            },
        ],
    )


def test_append_closes_only_the_answered_call():
    messages = [LLMMessage(role="assistant", content=None, tool_calls=_two_asks())]
    append_resumed_tool_results(messages, "ask_a", "用户确认了范围。")
    tool_msgs = [m for m in messages if m.role == "tool"]
    assert [m.tool_call_id for m in tool_msgs] == ["ask_a"]
    assert unclosed_tool_call_ids(messages) == ["ask_b"]


def test_persist_writes_only_answered_call():
    fact_log = TurnFactLog()
    token = current_fact_log.set(fact_log)
    sink = EventSink()
    try:
        persist_resumed_tool_results(
            [LLMMessage(role="assistant", content=None, tool_calls=_one_ask())],
            tool_call_id="ask_a",
            output="用户确认了范围。",
            run_id="cap",
            sink=sink,
            tool_name="ask_user",
        )
        entries = fact_log.entries()
    finally:
        current_fact_log.reset(token)

    call_facts = [e for e in entries if (e.get("kind") or "") == FactKind.TOOL_CALL.value]
    assert len(call_facts) == 1
    assert (call_facts[0].get("payload") or {}).get("tool_call_id") == "ask_a"
    ends = [e for e in sink._history if e.type == EventType.TOOL_USE_END]  # noqa: SLF001
    assert len(ends) == 1


def _single_ask_journal() -> list[dict]:
    return [
        TurnStartedFact(system_prompt="sys", user_message="hello", model_profile="m")
        .to_fact()
        .entry(),
        RoundBoundaryFact(round_idx=0, run_id="cap", role="captain").to_fact().entry(),
        LlmCallFact(
            run_id="cap",
            round_idx=0,
            tool_calls=[
                {
                    "id": "ask_a",
                    "type": "function",
                    "function": {"name": "ask_user", "arguments": '{"message":"范围？"}'},
                },
            ],
            finish_reason="tool_calls",
        )
        .to_fact()
        .entry(),
        {
            "kind": "checkpoint_required",
            "payload": {"checkpoint_id": "cp-a", "question": "范围？", "questions": []},
        },
    ]


@pytest.mark.asyncio
async def test_recover_single_ask_continues(monkeypatch):
    from agentcore.runtime.pipeline.resume import recover_path as rp
    from agentcore.runtime.recover import SettledSuspension

    journal = _single_ask_journal()
    suspension = _frame()
    suspension.journal_entries = journal
    window = [
        LLMMessage(role="system", content="sys"),
        LLMMessage(role="user", content="hello"),
        LLMMessage(role="assistant", content="先确认。", tool_calls=_one_ask()),
    ]
    monkeypatch.setattr(rp, "resumed_captain_window", lambda _s, _h: list(window))
    monkeypatch.setattr(
        rp,
        "recover_turn",
        AsyncMock(return_value=SettledSuspension("用户确认了范围。", None, ToolEffect.CONTINUE)),
    )
    fact_log = TurnFactLog(inherited_entries=list(journal))
    token = current_fact_log.set(fact_log)
    try:
        recovered = await rp.recover_and_rebuild_window(
            suspension=suspension,
            decision=CheckpointDecision.CONTINUE,
            note="",
            selected=[],
            history=None,
            sink=EventSink(),
            delegate_tool=AsyncMock(),
            debate_tool=None,
            execution_id="e1",
            captain_run_id="cap",
        )
    finally:
        current_fact_log.reset(token)

    assert recovered.settled.effect is ToolEffect.CONTINUE
    assert unclosed_tool_call_ids(recovered.messages) == []


@pytest.mark.asyncio
async def test_recover_legacy_parallel_asks_raises_not_re_pause(monkeypatch):
    from agentcore.runtime.pipeline.resume import recover_path as rp
    from agentcore.runtime.recover import SettledSuspension

    journal = _single_ask_journal()
    suspension = _frame(tool_calls=_two_asks())
    suspension.journal_entries = journal
    window = [
        LLMMessage(role="system", content="sys"),
        LLMMessage(role="user", content="hello"),
        LLMMessage(role="assistant", content="先确认两件事。", tool_calls=_two_asks()),
    ]
    monkeypatch.setattr(rp, "resumed_captain_window", lambda _s, _h: list(window))
    monkeypatch.setattr(
        rp,
        "recover_turn",
        AsyncMock(return_value=SettledSuspension("用户确认了范围。", None, ToolEffect.CONTINUE)),
    )
    fact_log = TurnFactLog(inherited_entries=list(journal))
    token = current_fact_log.set(fact_log)
    try:
        with pytest.raises(ResumeOpenToolCallsError):
            await rp.recover_and_rebuild_window(
                suspension=suspension,
                decision=CheckpointDecision.CONTINUE,
                note="",
                selected=[],
                history=None,
                sink=EventSink(),
                delegate_tool=AsyncMock(),
                debate_tool=None,
                execution_id="e1",
                captain_run_id="cap",
            )
    finally:
        current_fact_log.reset(token)


def _required(checkpoint_id: str, question: str) -> SimpleNamespace:
    return SimpleNamespace(
        type=SimpleNamespace(value="checkpoint_required"),
        payload={"checkpoint_id": checkpoint_id, "question": question},
        timestamp="t1",
    )


@pytest.mark.asyncio
async def test_parallel_capture_keeps_both_required_cards():
    transcript = [LLMMessage(role="assistant", content=None, tool_calls=_two_asks())]
    log = TurnFactLog()
    log.record_fact(
        TurnStartedFact(system_prompt="sys", user_message="hi", model_profile="m").to_fact()
    )
    ct_token = captain_transcript.set(transcript)
    fl_token = current_fact_log.set(log)
    saved: list[AskUserSuspension] = []

    def build_a(capture):
        return AskUserSuspension(
            message_id="msg-par",
            conversation_id="c1",
            user_id="u1",
            captain_run_id="cap",
            checkpoint_id="cp-a",
            tool_call_id="ask_a",
            base_system_prompt="sys",
            user_message="hi",
            question="先确认范围？",
            journal_entries=capture.journal_entries,
            transcript=capture.transcript,
        )

    def build_b(capture):
        return AskUserSuspension(
            message_id="msg-par",
            conversation_id="c1",
            user_id="u1",
            captain_run_id="cap",
            checkpoint_id="cp-b",
            tool_call_id="ask_b",
            base_system_prompt="sys",
            user_message="hi",
            question="区外目录写入授权",
            journal_entries=capture.journal_entries,
            transcript=capture.transcript,
        )

    async def saver(frame: AskUserSuspension) -> None:
        saved.append(frame)

    try:
        import asyncio

        await asyncio.gather(
            persist_suspension_capture(
                checkpoint_id="cp-a",
                required_event=_required("cp-a", "先确认范围？"),
                build_frame=build_a,
                saver=saver,
                suspension_kind="ask_user",
                message_id="msg-par",
            ),
            persist_suspension_capture(
                checkpoint_id="cp-b",
                required_event=_required("cp-b", "区外目录写入授权"),
                build_frame=build_b,
                saver=saver,
                suspension_kind="ask_user",
                message_id="msg-par",
            ),
        )
    finally:
        current_fact_log.reset(fl_token)
        captain_transcript.reset(ct_token)

    assert len(saved) == 2
    last = saved[-1]
    required_ids = {
        (e.get("payload") or {}).get("checkpoint_id")
        for e in last.journal_entries
        if (e.get("kind") or "") == "checkpoint_required"
    }
    assert required_ids == {"cp-a", "cp-b"}
