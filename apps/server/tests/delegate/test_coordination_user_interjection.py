"""协调中用户插话：注入事件队列 + CEO queue_user_message 转对话级排队。"""

from __future__ import annotations

import asyncio

import pytest

from agentcore.runtime.coordination.session import (
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
    active_coordination_for_conversation,
    clear_active_coordination,
    set_active_coordination,
)
from agentcore.runtime.coordination.tools import QueueUserMessageTool
from agentcore.runtime.events import EventSink
from agentcore.runtime.turn_queue import turn_queue
from agentcore.tools.protocol import ToolContext


@pytest.fixture(autouse=True)
def _clean_coord():
    clear_active_coordination()
    turn_queue.clear("conv-inj")
    yield
    clear_active_coordination()
    turn_queue.clear("conv-inj")


def test_active_coordination_for_conversation_index():
    session = CoordinationSession(
        execution_id="exec-inj",
        total_workers=2,
        conversation_id="conv-inj",
    )
    set_active_coordination(session)
    assert active_coordination_for_conversation("conv-inj") is session
    clear_active_coordination("exec-inj")
    assert active_coordination_for_conversation("conv-inj") is None


def test_user_interjection_is_necessary_decision():
    session = CoordinationSession(execution_id="e", total_workers=2)
    ev = CoordinationEvent(
        kind=CoordinationEventKind.USER_INTERJECTION,
        payload={"interjection_id": "i1", "content": "加一句成本"},
    )
    assert session.is_necessary_decision([ev]) is True


@pytest.mark.asyncio
async def test_queue_user_message_enqueues_and_emits_queued():
    session = CoordinationSession(
        execution_id="exec-inj",
        total_workers=2,
        conversation_id="conv-inj",
    )
    set_active_coordination(session)
    session.stash_interjection(
        "inj-1",
        {
            "content": "无关的贺卡请求",
            "user_id": "u1",
            "conversation_id": "conv-inj",
            "attachments": [],
            "requires_tools": False,
        },
    )
    session.post(
        CoordinationEvent(
            kind=CoordinationEventKind.USER_INTERJECTION,
            payload={"interjection_id": "inj-1", "content": "无关的贺卡请求"},
        )
    )

    sink = EventSink()
    tool = QueueUserMessageTool(sink=sink)
    from unittest.mock import MagicMock

    ctx = ToolContext(
        execution_id="exec-inj",
        run_id="ceo",
        agent_id="ceo",
        backend=MagicMock(),
        user_id="u1",
        conversation_id="conv-inj",
    )
    result = await tool.execute(
        {"interjection_id": "inj-1", "reason": "无关"},
        ctx,
    )
    assert result.success is True
    assert turn_queue.depth("conv-inj") == 1
    assert session.get_interjection("inj-1") is None

    hist = list(sink._history)
    types = [e.type.value for e in hist]
    assert "user_interjection" in types
    last = next(e for e in reversed(hist) if e.type.value == "user_interjection")
    assert last.payload["status"] == "queued"
    assert last.payload["interjection_id"] == "inj-1"


@pytest.mark.asyncio
async def test_wait_events_surfaces_user_interjection():
    session = CoordinationSession(execution_id="e2", total_workers=2)

    async def _post_soon() -> None:
        await asyncio.sleep(0.01)
        session.post(
            CoordinationEvent(
                kind=CoordinationEventKind.USER_INTERJECTION,
                payload={"interjection_id": "i", "content": "hi"},
            )
        )

    asyncio.create_task(_post_soon())
    batch = await session.wait_events(timeout=1.0)
    assert len(batch) == 1
    assert batch[0].kind is CoordinationEventKind.USER_INTERJECTION
