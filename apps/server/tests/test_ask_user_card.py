"""ask_user card shape: questions required; unknown extra keys dropped."""

from __future__ import annotations

import json
from pathlib import Path

from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.suspension import captain_transcript
from agentcore.tools.builtin.ask_user import AskUserTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx() -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
        conversation_id="c1",
    )


def _tool(*, saver=None) -> AskUserTool:
    return AskUserTool(
        sink=EventSink(),
        conversation_id="c1",
        timeout_seconds=1.0,
        message_id="m1" if saver else None,
        suspension_saver=saver,
        captain_run_id="ceo",
        base_system_prompt="sys",
        user_message="hi",
    )


def test_ask_user_schema_does_not_expose_blocking():
    tool = AskUserTool(
        sink=EventSink(),
        conversation_id="c1",
        timeout_seconds=30.0,
    )
    props = tool.schema.parameters["properties"]
    assert set(props) == {"questions", "browser_login"}
    assert props["questions"]["minItems"] == 1
    assert tool.schema.parameters["required"] == ["questions"]


async def test_ask_user_drops_extra_context_key():
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    tool = _tool(saver=_save)
    token = captain_transcript.set([LLMMessage(role="user", content="选")])
    try:
        res = await tool.execute(
            {
                "questions": [{"prompt": "只问这一句"}],
                "message": "不该当题干",
                "context": "旧槽不该并进",
            },
            _ctx(),
        )
    finally:
        captain_transcript.reset(token)

    assert res.success is True
    assert saved[0].question == "只问这一句"
    assert "context" not in saved[0].to_json()
    required = next(e for e in tool.sink._history if e.type is EventType.CHECKPOINT_REQUIRED)
    assert required.payload["question"] == "只问这一句"
    assert "context" not in required.payload


async def test_ordinary_choice_ask_is_decision():
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    tool = _tool(saver=_save)
    token = captain_transcript.set([LLMMessage(role="user", content="选方案")])
    try:
        res = await tool.execute(
            {
                "questions": [
                    {
                        "prompt": "选哪条方案？",
                        "kind": "choice",
                        "multiple": False,
                        "options": ["方案 A：快速原型", "方案 B：稳妥重构（推荐）"],
                    }
                ],
            },
            _ctx(),
        )
    finally:
        captain_transcript.reset(token)

    assert res.success is True
    assert saved[0].intent == "decision"
    assert saved[0].question == "选哪条方案？"
    required = next(e for e in tool.sink._history if e.type is EventType.CHECKPOINT_REQUIRED)
    assert required.payload["intent"] == "decision"
    assert required.payload["questions"][0]["multiple"] is False


async def test_ordinary_ask_caps_choice_options_at_six():
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    tool = _tool(saver=_save)
    token = captain_transcript.set([LLMMessage(role="user", content="勾选")])
    try:
        res = await tool.execute(
            {
                "questions": [
                    {
                        "prompt": "勾选要处理的风险",
                        "kind": "choice",
                        "multiple": True,
                        "options": [f"风险 {i}" for i in range(8)],
                    }
                ],
            },
            _ctx(),
        )
    finally:
        captain_transcript.reset(token)
    assert res.success is True
    required = next(e for e in tool.sink._history if e.type is EventType.CHECKPOINT_REQUIRED)
    assert len(required.payload["questions"][0]["options"]) == 6


def _detailed_choice(*, n: int, multiple: bool, detail: str = "一行取舍"):
    return [
        {
            "prompt": "选？",
            "kind": "choice",
            "multiple": multiple,
            "options": [{"label": f"项 {i}", "detail": detail} for i in range(n)],
        }
    ]


def _with_ask_transcript(*, prompt: str):
    args: dict = {"questions": [{"prompt": prompt}]}
    return captain_transcript.set(
        [
            LLMMessage(role="user", content="hi"),
            LLMMessage(
                role="assistant",
                content="",
                tool_calls=[
                    ToolCall(
                        id="ask",
                        function=ToolCallFunction(
                            name="ask_user",
                            arguments=json.dumps(args),
                        ),
                    )
                ],
            ),
        ]
    )


async def test_ordinary_ask_drops_option_detail_even_if_model_filled():
    saved: list = []

    async def _save(frame):
        saved.append(frame)

    tool = _tool(saver=_save)
    token = _with_ask_transcript(prompt="选方向")
    try:
        res = await tool.execute(
            {
                "questions": _detailed_choice(n=2, multiple=False, detail="不该出现"),
            },
            _ctx(),
        )
    finally:
        captain_transcript.reset(token)
    assert res.success is True
    assert saved
    required = next(e for e in tool.sink._history if e.type is EventType.CHECKPOINT_REQUIRED)
    opts = required.payload["questions"][0]["options"]
    assert [o["label"] for o in opts] == ["项 0", "项 1"]
    assert all("detail" not in o for o in opts)
