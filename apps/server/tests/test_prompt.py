"""Tests for system-prompt assembly (`assemble_system_prompt`).

Pins the shared <output_style> contract that keeps the whole team's voice
professional and anti-"AI slop": emoji are off by default with a soft carve-out,
formatting stays proportional to the content, and structure is expressed via the
Markdown the UI renders. Because the block lives in the shared base, it must reach
both the CEO chat agent and every delegated worker — and survive the optional
memory / attachment-context sections being layered on top.
"""

from agentcore.runtime.prompt import (
    CHAT_TEAM_CAPABILITY_HINT,
    assemble_system_prompt,
)


def test_output_style_block_present_in_base():
    out = assemble_system_prompt()
    assert "<output_style>" in out
    assert "</output_style>" in out


def test_emoji_banned_with_soft_carve_out():
    out = assemble_system_prompt()
    assert "emoji" in out
    # Default-off, but allowed when the user uses one first or explicitly asks.
    assert "除非用户" in out
    assert "明确要求" in out


def test_anti_filler_and_formatting_restraint():
    out = assemble_system_prompt()
    # No sycophantic openers/closers.
    assert "好问题" in out
    assert "希望对你有帮助" in out
    # Formatting is proportional, not decorative.
    assert "滥用列表" in out


def test_render_capabilities_advertised():
    out = assemble_system_prompt()
    assert "Markdown" in out
    assert "LaTeX" in out


def test_tool_safety_block_present_in_base():
    # Approval-gated, environment-changing tools carry a shared caution in the base
    # prompt: call them freely (the gate handles consent) but treat irreversible /
    # destructive ops carefully — especially local mode (the user's real machine).
    out = assemble_system_prompt()
    assert "<tool_safety>" in out
    assert "确认" in out
    assert "本地模式" in out


def test_output_style_survives_memory_and_context_layers():
    out = assemble_system_prompt(
        memory_markdown="- 用户偏好简洁回复",
        extra_context="<attached_files>...</attached_files>",
    )
    # The shared style block is not crowded out by the optional sections.
    assert "<output_style>" in out
    assert "用户偏好简洁回复" in out
    assert "<attached_files>" in out


def test_style_precedes_ceo_only_team_hint_when_composed():
    # The CEO prompt is base + team hint (see pipeline.run_chat_pipeline). The
    # shared style must come from the base, independent of the CEO-only hint.
    base = assemble_system_prompt()
    assert "<output_style>" in base
    assert "<output_style>" not in CHAT_TEAM_CAPABILITY_HINT


def test_team_hint_teaches_delegate_knobs():
    # The CEO is taught the delegate knobs that are otherwise "dark features":
    # the cost tier (fast/strong), the quality contract, and output shaping.
    hint = CHAT_TEAM_CAPABILITY_HINT
    assert "fast" in hint
    assert "strong" in hint
    assert "contract" in hint
    assert "expected_output" in hint


def test_team_hint_states_coordinator_tool_boundary():
    # 协调者 CEO: the CEO holds only read/retrieval tools and must delegate any work
    # that produces or changes an artifact (even a single file). Pin that the
    # boundary is taught, so the prompt can't silently regress to a do-it-all CEO
    # whose instructions no longer match its (read-only) toolset.
    hint = CHAT_TEAM_CAPABILITY_HINT
    assert "只读" in hint
    assert "delegate" in hint
    # The hint must steer production/mutation to a worker, not the CEO's own hands.
    assert "交给 worker" in hint
