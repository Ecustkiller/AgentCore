"""Tests for system-prompt assembly (`assemble_system_prompt`).

Pins the shared <output_style> contract that keeps the whole team's voice
professional and anti-"AI slop": emoji are off by default with a soft carve-out,
formatting stays proportional to the content, and structure is expressed via the
Markdown the UI renders. Because the block lives in the shared base, it must reach
both the CEO chat agent and every delegated worker — and survive the optional
memory / attachment-context sections being layered on top.
"""

from agentcore.runtime.prompt import (
    CHAT_CHECKPOINT_HINT,
    CHAT_CITATION_HINT,
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


def test_team_hint_teaches_finalize_for_single_delivery():
    # 提案2a: the CEO learns it can finalize a single self-contained delivery, so a
    # one-worker job is surfaced directly without a redundant synthesis round.
    assert "finalize" in CHAT_TEAM_CAPABILITY_HINT


def test_team_hint_teaches_debate_stance_tagging():
    # 辩论/审查 (前端UX设计.md §四③): the CEO tags opposing tasks with stance so the
    # frontend can tell a debate from普通并行 — the only signal, since执行 is identical
    # (守住「形状是数据不是模式」). Pin it so the always-on hint keeps teaching it.
    hint = CHAT_TEAM_CAPABILITY_HINT
    assert "stance" in hint
    assert "pro" in hint and "con" in hint
    assert "辩论" in hint


def test_team_hint_teaches_multi_round_debate():
    # 真·多轮辩论 (Agent协作模式 §7.4): a real back-and-forth debate is just a DAG —
    # the CEO tags each task's `round` and wires 跨轮 depends_on (round-k 依赖对方
    # round-(k-1)) so每轮 rebuts the last. The mechanism + 前端逐轮渲染 are already
    # landed, so the always-on hint must keep teaching the CEO to USE them, else
    # multi-round silently never happens. Pin round + 跨轮 so a refactor can't drop it.
    # 同时 pin 克制约束: docs 把 multi-round 定为边际/niche, 故 hint 须先导向单轮、仅确需
    # 层层反驳才多轮且克制轮数, 防 CEO 滥用昂贵的多轮.
    hint = CHAT_TEAM_CAPABILITY_HINT
    assert "多轮辩论" in hint
    assert "round" in hint
    assert "跨轮" in hint
    assert "克制" in hint


def test_checkpoint_hint_teaches_debate_closing_with_options():
    # ⑤: a debate closes by handing the采纳 A/B choice to the user via ask_user
    # options — no new checkpoint type (复用现有机制). It must live in the checkpoint
    # hint (shown only when ask_user is actually wired), not the always-on team hint.
    assert "采纳正方" in CHAT_CHECKPOINT_HINT
    assert "options" in CHAT_CHECKPOINT_HINT
    assert "采纳正方" not in CHAT_TEAM_CAPABILITY_HINT


def test_citation_hint_teaches_multi_source_anchoring():
    # When several sources back one claim, the CEO anchors all of them ([1][2]), not
    # only the source tied to the final conclusion — every contributing source must
    # stay traceable from the prose (UI 引用卡 already lists them; this adds the
    # inline anchor).
    hint = CHAT_CITATION_HINT
    assert "一并标注" in hint
    assert "[1][2]" in hint


def test_team_hint_teaches_split_criterion_over_count():
    # 拆分判据 = 子任务是否真正独立可并行 / 需不同专长, NOT 任务数量 — replaces the
    # vague「少数几个」the CEO itself flagged as un-actionable.
    hint = CHAT_TEAM_CAPABILITY_HINT
    assert "独立" in hint and "并行" in hint and "专长" in hint
    assert "不看数量" in hint


def test_team_hint_distinguishes_dag_depth_from_nesting():
    # A multi-stage pipeline is a DAG within ONE delegate call (depends_on, same
    # layer, depth 1) — NOT nesting. can_delegate is the other axis, only for a
    # single task that needs its own sub-team. Pin the distinction so the CEO stops
    # conflating pipeline length with delegation depth.
    hint = CHAT_TEAM_CAPABILITY_HINT
    assert "depends_on" in hint
    assert "can_delegate" in hint
    assert "同一层" in hint


def test_team_hint_reminds_pass_hidden_context_to_worker():
    # A worker never sees the conversation history, so the CEO must write the
    # decision's key assumptions / constraints into the task itself.
    hint = CHAT_TEAM_CAPABILITY_HINT
    assert "看不到" in hint
    assert "对话历史" in hint


def test_checkpoint_hint_teaches_proceed_and_annotate_assumption():
    # The non-interrupt branch: when proceeding on a non-trivial default, the CEO
    # flags the assumption inline so the user can cheaply correct it — the adopted
    # half of the「置信度」idea, without a (miscalibrated) numeric threshold.
    hint = CHAT_CHECKPOINT_HINT
    assert "假设" in hint
    assert "若不符请指正" in hint
