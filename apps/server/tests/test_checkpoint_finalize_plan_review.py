"""checkpoint_after extra key is ignored: captain loop + delegate DAG runs through.

Leftover plan_review pause is gone. Extra ``checkpoint_after`` on tasks does not
SUSPEND / PAUSED-finish. Both workers run and the captain answers.
"""

import json
from pathlib import Path

from agentcore.llm.provider.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.engine import ReactLoopOut, react_loop
from agentcore.runtime.events import EventSink, FinishReason
from agentcore.runtime.facts import TurnFactLog, TurnStartedFact, current_fact_log
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.suspension import captain_transcript
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace
from tests.delegate.conftest import _TEST_BIRTH_FOLDER_ID, _upstream_body
from tests.llm_helpers import make_profile_params


class _ScriptedProvider:
    """Yields one pre-scripted chunk list per ``stream`` call (one call per round)."""

    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


def _context() -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="cap",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


async def test_loop_runs_through_when_checkpoint_after_is_extra_key():
    system_prompt = "你是 CEO。"
    user_message = "调研并撰写"
    captured: dict[str, object] = {}

    async def saver(frame) -> None:  # noqa: ANN001 - TurnSuspension
        captured["frame"] = frame

    async def deleter(_message_id: str) -> None:
        captured["deleted"] = True

    sink = EventSink()
    registry = InteractionRegistry()
    s1_body = _upstream_body("S1OUT")
    worker_provider = _ScriptedProvider(
        [[LLMChunk(delta_content=s1_body)], [LLMChunk(delta_content="S2OUT")]]
    )
    delegate = DelegateTool(
        llm=worker_provider,
        sink=sink,
        system_prompt=system_prompt,
        user_message=user_message,
        history=[],
        tools=ToolRegistry(),
        base_tool_context=_context(),
        conversation_id="c1",
        registry=registry,
        checkpoint_timeout_seconds=5.0,
        checkpoint_enabled=True,
        message_id="m1",
        suspension_saver=saver,
        suspension_deleter=deleter,
        captain_run_id="cap",
        folder_id=_TEST_BIRTH_FOLDER_ID,
        approval_gate=None,
    )
    reg = ToolRegistry()
    reg.register(delegate)

    dag = [
        {"id": "s1", "role": "研究员", "task": "调研", "checkpoint_after": True},
        {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    ]
    captain_provider = _ScriptedProvider(
        [
            [
                LLMChunk(
                    delta_tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="call_del",
                            function_name="delegate",
                            arguments_delta=json.dumps(
                                {"tasks": dag, "coordinate": False}
                            ),
                        )
                    ]
                )
            ],
            [LLMChunk(delta_content="最终答复")],
        ]
    )

    messages = [
        LLMMessage(role="system", content=system_prompt),
        LLMMessage(role="user", content=user_message),
    ]
    profile = make_profile_params(max_rounds=5)
    log = TurnFactLog()
    log.record_fact(
        TurnStartedFact(
            system_prompt=system_prompt, user_message=user_message, model_profile="m"
        ).to_fact()
    )
    finish_override: list[FinishReason] = []
    fl_token = current_fact_log.set(log)
    ct_token = captain_transcript.set(messages)
    try:
        content, _reasoning, _usage, _rounds = await react_loop(
            messages=messages,
            llm=captain_provider,
            tools=reg,
            sink=sink,
            tool_context=_context(),
            profile=profile,
            turn_model="m",
            out=ReactLoopOut(finish_override=finish_override),
            run_id="cap",
            role="captain",
            approval_gate=None,
        )
    finally:
        captain_transcript.reset(ct_token)
        current_fact_log.reset(fl_token)

    assert FinishReason.PAUSED not in finish_override
    assert "最终答复" in (content or "")
    assert worker_provider.calls == 2
    assert captain_provider.calls == 2
    assert captured == {}
    assert registry.list_pending("c1") == []
    assert any(m.role == "tool" for m in messages)
    assert not any(str(e.type) == "plan_review_required" for e in sink._history)
