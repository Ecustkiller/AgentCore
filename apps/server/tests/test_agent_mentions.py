"""Conversation-page ``agent_mentions`` soft prompt (非强制派单)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from agentcore.api.schemas.messages import AgentMention, SendMessageRequest
from agentcore.runtime.pipeline import (
    _build_agent_mention_context,
    merge_attachment_and_mention_context,
)
from agentcore.runtime.turn_queue import new_queued_turn
from agentcore.runtime.turn_steer import _reset_for_tests as reset_steer
from agentcore.runtime.turn_steer import begin_accepting, try_enqueue


def test_send_message_request_agent_mentions_default_empty():
    body = SendMessageRequest(content="hi", delivery="steer")
    assert body.agent_mentions == []


def test_send_message_request_agent_mentions_max_length():
    ok = [
        AgentMention(agent_id=f"a{i}", role=f"role-{i}") for i in range(10)
    ]
    body = SendMessageRequest(content="hi", delivery="queue", agent_mentions=ok)
    assert len(body.agent_mentions) == 10

    too_many = ok + [AgentMention(agent_id="x", role="extra")]
    with pytest.raises(ValidationError):
        SendMessageRequest(content="hi", delivery="queue", agent_mentions=too_many)


def test_agent_mention_field_bounds():
    with pytest.raises(ValidationError):
        AgentMention(agent_id="", role="r")
    with pytest.raises(ValidationError):
        AgentMention(agent_id="a" * 129, role="r")
    with pytest.raises(ValidationError):
        AgentMention(agent_id="a", role="")
    with pytest.raises(ValidationError):
        AgentMention(agent_id="a", role="r" * 201)


def test_build_agent_mention_context_empty():
    assert _build_agent_mention_context(None) is None
    assert _build_agent_mention_context([]) is None
    assert _build_agent_mention_context([{"agent_id": "", "role": "x"}]) is None


def test_build_agent_mention_context_renders_soft_hint():
    out = _build_agent_mention_context(
        [
            {"agent_id": "agent_research", "role": "研究员"},
            {"agent_id": "agent_writer", "role": "写手"},
        ]
    )
    assert out is not None
    assert "用户点名关注以下 Agent（软提示，非强制派单/非硬路由）" in out
    assert "- 研究员 (id=agent_research)" in out
    assert "- 写手 (id=agent_writer)" in out
    assert "<agent_mentions>" in out


def test_merge_empty_mentions_keeps_attachment_only():
    att = "<attached_files>\nbody\n</attached_files>"
    assert merge_attachment_and_mention_context(att, None) == att
    assert merge_attachment_and_mention_context(att, []) == att
    assert merge_attachment_and_mention_context(None, None) is None


def test_merge_mentions_only_and_with_attachments():
    mentions = [{"agent_id": "a1", "role": "法务"}]
    only = merge_attachment_and_mention_context(None, mentions)
    assert only is not None
    assert "法务 (id=a1)" in only
    assert "<attached_files>" not in only

    att = "<attached_files>\nfile\n</attached_files>"
    both = merge_attachment_and_mention_context(att, mentions)
    assert both is not None
    assert both.startswith(att)
    assert "法务 (id=a1)" in both
    assert "软提示，非强制派单/非硬路由" in both


def test_queued_turn_preserves_agent_mentions():
    mentions = [{"agent_id": "a1", "role": "研究员"}]
    item = new_queued_turn(
        content="go",
        user_id="u1",
        attachments=[{"name": "a.txt", "path": "a.txt"}],
        agent_mentions=mentions,
    )
    assert item.agent_mentions == mentions
    assert item.attachments[0]["name"] == "a.txt"


def test_steer_enqueue_preserves_agent_mentions():
    reset_steer()
    begin_accepting("c1")
    mentions = [{"agent_id": "a1", "role": "写手"}]
    parked = try_enqueue(
        conversation_id="c1",
        content="nudge",
        user_id="u1",
        attachments=[],
        agent_mentions=mentions,
    )
    assert parked is not None
    assert parked.agent_mentions == mentions
    reset_steer()
