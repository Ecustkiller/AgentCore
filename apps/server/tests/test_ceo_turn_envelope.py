"""CEO turn envelope: volatile facts outside ``role: system``."""

from __future__ import annotations

import re

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.facts import TurnStartedFact
from agentcore.runtime.journal import window_from_journal
from agentcore.runtime.resolve.prompt import (
    TURN_ENVELOPE_FENCE,
    assemble_system_prompt,
    compose_ceo_chat_prompt,
    compose_worker_base_prompt,
    opening_ceo_messages,
    render_ceo_turn_envelope,
    visualization_system_body,
)
from agentcore.runtime.skills import build_system_skill_registry


def test_frozen_ceo_system_omits_runtime_and_workspace():
    ceo = compose_ceo_chat_prompt(
        assemble_system_prompt(),
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult"},
    )
    assert "<运行时>" not in ceo
    assert "</工作区>" not in ceo
    assert "<身份>" in ceo
    assert "<按需目录>" in ceo


def test_envelope_carries_date_workspace_and_fence():
    env = render_ceo_turn_envelope(
        workspace_context="<工作区>\n执行：云端\n</工作区>",
        workspace_file_index="文件：空",
    )
    assert env.startswith(TURN_ENVELOPE_FENCE)
    assert re.search(r"当前日期：\d{4}-\d{2}-\d{2}", env)
    assert not re.search(r"\d{2}:\d{2}:\d{2}", env)
    assert "<工作区>" in env
    assert "文件：空" in env
    assert env.index("执行：云端") < env.index("文件：空") < env.index("</工作区>")


def test_envelope_date_stable_within_a_day():
    a = render_ceo_turn_envelope(include_runtime=True)
    b = render_ceo_turn_envelope(include_runtime=True)
    assert a == b


def test_worker_keeps_date_and_workspace_in_system():
    facts = "<工作区>\n执行：云端\n</工作区>"
    worker = compose_worker_base_prompt(assemble_system_prompt(), workspace_context=facts)
    assert "<运行时>" in worker
    assert re.search(r"当前日期：\d{4}-\d{2}-\d{2}", worker)
    assert worker.index("</运行时>") < worker.index("<工作区>\n")


def test_opening_messages_insert_envelope_between_history_and_user():
    history = [LLMMessage(role="user", content="hi"), LLMMessage(role="assistant", content="ok")]
    messages = opening_ceo_messages(
        system_prompt="SYS",
        history=history,
        turn_envelope=f"{TURN_ENVELOPE_FENCE}\n<运行时/>",
        user_content="go",
    )
    assert [m.role for m in messages] == ["system", "user", "assistant", "user", "user"]
    assert messages[0].content == "SYS"
    assert messages[3].content.startswith(TURN_ENVELOPE_FENCE)
    assert messages[4].content == "go"


def test_opening_omits_empty_envelope():
    messages = opening_ceo_messages(
        system_prompt="SYS",
        history=None,
        turn_envelope="",
        user_content="go",
    )
    assert messages == [
        LLMMessage(role="system", content="SYS"),
        LLMMessage(role="user", content="go"),
    ]


def test_fold_inserts_envelope_from_turn_started():
    env = f"{TURN_ENVELOPE_FENCE}\n<工作区>\n执行：云端\n</工作区>"
    entries = [
        TurnStartedFact(
            system_prompt="SYS",
            user_message="go",
            model_profile="m",
            turn_envelope=env,
        )
        .to_fact()
        .entry()
    ]
    assert window_from_journal(entries) == opening_ceo_messages(
        system_prompt="SYS",
        history=None,
        turn_envelope=env,
        user_content="go",
    )


def test_fold_old_journal_without_envelope_unchanged():
    entries = [
        {
            "kind": "turn_started",
            "payload": {
                "system_prompt": "SYS",
                "user_message": "go",
                "model_profile": "m",
                "history_len": 0,
            },
            "ts": None,
        }
    ]
    assert window_from_journal(entries) == [
        LLMMessage(role="system", content="SYS"),
        LLMMessage(role="user", content="go"),
    ]


def test_visualization_concatenates_envelope_xml_into_system():
    env = render_ceo_turn_envelope(
        workspace_context="<工作区>\n桌：设计\n</工作区>",
        include_runtime=False,
    )
    body = visualization_system_body("你是 CEO。", env)
    assert TURN_ENVELOPE_FENCE not in body
    assert body.startswith("你是 CEO。")
    assert "<工作区>" in body
    assert "桌：设计" in body
