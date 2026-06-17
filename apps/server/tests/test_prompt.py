"""Tests for system-prompt assembly (`assemble_system_prompt`) and the slim CEO core.

Pins two things:

1. The shared <output_style> / <tool_safety> contract that keeps the whole team's
   voice professional and anti-"AI slop" — it lives in the base prompt, so it must
   reach both the CEO chat agent and every delegated worker, and survive the
   optional memory / attachment-context sections layered on top.
2. The SLIM CEO core (提示词瘦身 P2): ``_CEO_CORE_HINT`` keeps only the always-on
   routing spine (tool boundary / split criterion / hidden-context rule / same-layer
   pipeline / synthesize-don't-restate) + a pointer to ``consult_skill`` and the
   能力目录. The rarely-used「怎么做」detail (multi-round debate / nested delegation /
   asking the user / revise) is moved into system Skills
   (runtime/skills.py, see test_skills.py) — so it must NOT ride the core every turn.
"""

import re

from agentcore.runtime.prompt import (
    _CEO_CORE_HINT,
    CHAT_CITATION_HINT,
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


def test_tool_use_block_teaches_parallel_calls():
    # The executor already runs a round's tool_calls concurrently (engine
    # _execute_tools: asyncio.gather + semaphore). The only missing lever was telling
    # the model to BATCH independent calls into one round so that concurrency is
    # actually used (otherwise the ReAct loop emits one call per round = serial). This
    # guidance lives in the shared base prompt so both the CEO and every worker batch
    # independent retrievals. Pin it so a refactor can't silently re-idle the
    # concurrent executor.
    out = assemble_system_prompt()
    assert "<tool_use>" in out
    assert "互相独立" in out
    assert "并发" in out
    assert "一次性" in out


def test_runtime_context_uses_date_granularity_for_cache_stability():
    # The runtime-context line sits in the system-prompt prefix BEFORE the large
    # stable hint stack, so it must NOT carry second-precision time: a value that
    # changed every turn broke DeepSeek's exact-prefix cache for everything after it
    # (the whole CEO hint stack got re-billed each turn). Pin date granularity + the
    # call-to-call stability that makes the stable core cacheable within a day, so a
    # refactor can't silently reintroduce the cache-buster.
    out = assemble_system_prompt()
    assert re.search(r"当前日期：\d{4}-\d{2}-\d{2}", out)
    assert not re.search(r"\d{2}:\d{2}:\d{2}", out)  # no HH:MM:SS timestamp
    assert assemble_system_prompt() == out  # byte-identical across calls (same day)


def test_output_style_survives_memory_and_context_layers():
    out = assemble_system_prompt(
        memory_markdown="- 用户偏好简洁回复",
        extra_context="<attached_files>...</attached_files>",
    )
    # The shared style block is not crowded out by the optional sections.
    assert "<output_style>" in out
    assert "用户偏好简洁回复" in out
    assert "<attached_files>" in out


def test_style_precedes_ceo_only_core_when_composed():
    # The CEO prompt is base + core hint (see pipeline.run_chat_pipeline). The
    # shared style must come from the base, independent of the CEO-only core.
    base = assemble_system_prompt()
    assert "<output_style>" in base
    assert "<output_style>" not in _CEO_CORE_HINT


def test_core_states_coordinator_tool_boundary():
    # 协调者 CEO: the CEO holds only read/retrieval tools and must delegate any work
    # that produces or changes an artifact (even a single file). Pin that the
    # boundary is taught, so the prompt can't silently regress to a do-it-all CEO
    # whose instructions no longer match its (read-only) toolset.
    hint = _CEO_CORE_HINT
    assert "只读" in hint
    assert "delegate" in hint
    # The hint must steer production/mutation to a worker, not the CEO's own hands.
    assert "交给 worker" in hint


def test_core_teaches_split_criterion_over_count():
    # 拆分判据 = 活儿的自然结构（子任务是否真正独立可并行 / 需不同专长），NOT 任务数量.
    # The criterion is BIDIRECTIONAL: both over-splitting and collapsing a naturally
    # multi-part deliverable into one worker are deviations. The core must warn against
    # under-teaming (the「组队太保守」regression), not only against over-splitting —
    # so a refactor can't quietly revert to a single-direction「别拆碎」brake.
    hint = _CEO_CORE_HINT
    assert "独立" in hint and "并行" in hint and "专长" in hint
    assert "不是数量本身" in hint
    assert "塌缩" in hint  # the reverse signal: don't collapse multi-part work into one


def test_core_teaches_same_layer_pipeline():
    # A multi-stage pipeline is a DAG within ONE delegate call (depends_on, same
    # layer) — the high-frequency case stays in the core. The nesting axis
    # (can_delegate) is advanced and moved to the team_orchestration_advanced skill.
    hint = _CEO_CORE_HINT
    assert "depends_on" in hint
    assert "同一层" in hint


def test_core_teaches_delegating_parallel_research():
    # C: deliverable-scale research that spans independent angles is TEAM work — the
    # CEO must fan it out to parallel research workers (which hold retrieval tools too),
    # not run all retrieval serially itself and delegate only the writing (the
    # 「调研收归 CEO 串行」 regression seen in the law conversation). Its own retrieval
    # stays for direct answers / light orientation (探路), not the deliverable's legwork.
    hint = _CEO_CORE_HINT
    assert "调研" in hint
    assert "探路" in hint


def test_core_reminds_pass_hidden_context_to_worker():
    # A worker never sees the conversation history, so the CEO must write the
    # decision's key assumptions / constraints into the task itself.
    hint = _CEO_CORE_HINT
    assert "看不到" in hint
    assert "对话历史" in hint


def test_core_teaches_constraint_vs_solution_boundary():
    # 认知分工边界（约束 vs 方案）: the CEO writes requirements/constraints into the
    # task, but leaves the deliverable's professional STRUCTURE (a paper's chapters /
    # argument, a codebase's architecture) to the expert worker — unless the user
    # fixed it. Pins the fix for the「CEO 替专家把方案定死、worker 沦为填字员」regression
    # (法律论文案例) so a refactor can't revert to a single-direction「写清约束」brake.
    hint = _CEO_CORE_HINT
    assert "专业方案" in hint
    assert "填字员" in hint


def test_core_points_to_consult_skill_and_directory():
    # 提示词瘦身 P2: the slim core must point the CEO at consult_skill + the 能力目录
    # so it knows the advanced「怎么做」guidance is pull-on-demand, not missing.
    hint = _CEO_CORE_HINT
    assert "consult_skill" in hint
    assert "能力目录" in hint


def test_core_drops_advanced_mechanism_detail():
    # Regression guard for P2: the rarely-used machinery now lives in system Skills,
    # so its DETAIL must not creep back into the always-on core (that would re-inflate
    # the per-turn prompt). These tokens are unique to the moved-out skill bodies.
    hint = _CEO_CORE_HINT
    for token in ("多轮辩论", "跨轮", "stance", "采纳正方", "checkpoint_after", "target_run_id"):
        assert token not in hint, f"advanced detail '{token}' leaked back into the core"


def test_citation_hint_teaches_multi_source_anchoring():
    # When several sources back one claim, the CEO anchors all of them ([1][2]), not
    # only the source tied to the final conclusion — every contributing source must
    # stay traceable from the prose (UI 引用卡 already lists them; this adds the
    # inline anchor). citation stays inline (not a skill — short + only relevant when
    # web results were used).
    hint = CHAT_CITATION_HINT
    assert "一并标注" in hint
    assert "[1][2]" in hint
