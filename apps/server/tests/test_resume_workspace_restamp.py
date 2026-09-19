"""Resume restamp of ``<工作区>`` is a post-history ``[系统提示]`` envelope."""

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.pipeline.resume.pipeline import _restamp_workspace_facts
from agentcore.runtime.pipeline.resume.wire import append_workspace_restamp_envelope
from agentcore.runtime.resolve.prompt.envelope import TURN_ENVELOPE_FENCE


def test_restamp_emits_envelope_when_cloud_facts_go_local():
    old = (
        "<运行时>\n当前日期：2026-07-12\n</运行时>\n"
        "<工作区>\n执行：云端沙箱\n</工作区>\n"
        "rest of prompt"
    )
    new = (
        "<工作区>\n"
        "执行：用户本机\n"
        "</工作区>"
    )
    out = _restamp_workspace_facts(old, new)
    assert out.startswith(TURN_ENVELOPE_FENCE)
    assert "云端沙箱" not in out
    assert "用户本机" in out
    assert "rest of prompt" not in out
    # Frozen system is not rewritten.
    assert "云端沙箱" in old
    assert old.count("<工作区>") == 1


def test_restamp_skips_when_prompt_has_no_workspace_block():
    old = (
        "<运行时>\n当前日期：2026-07-12\n</运行时>\n"
        "<按需目录>\n- terminal\n</按需目录>\n"
        "<附件>\nfile.md\n</附件>"
    )
    new = "<工作区>\n执行：用户本机\n</工作区>"
    assert _restamp_workspace_facts(old, new) == ""
    assert "<工作区>" not in old


def test_restamp_skips_when_facts_already_match():
    block = "<工作区>\n执行：用户本机\n</工作区>"
    old = f"<运行时>\n当前日期：2026-07-12\n</运行时>\n{block}\nrest"
    assert _restamp_workspace_facts(old, block) == ""


def test_append_restamp_envelope_after_history():
    messages = [
        LLMMessage(role="system", content="frozen"),
        LLMMessage(role="user", content="hello"),
    ]
    env = f"{TURN_ENVELOPE_FENCE}\n<工作区>\n执行：用户本机\n</工作区>"
    append_workspace_restamp_envelope(messages, env)
    assert messages[-1].role == "user"
    assert messages[-1].content == env
    append_workspace_restamp_envelope(messages, env)
    assert len(messages) == 3
