"""Tests for system-prompt assembly (`assemble_system_prompt`) and the slim CEO core.

Pins two things:

1. The shared <output_style> contract that keeps the whole team's voice professional
   and anti-"AI slop" — it lives in the base prompt, so it must reach both the CEO
   chat agent and every delegated worker, and survive the optional memory /
   attachment-context sections layered on top. (<tool_safety> used to be shared here
   too, but 按角色 right-size 反向 moved it onto the worker identities — the coordinator
   CEO holds only read-only tools — so this file pins its ABSENCE from the base/CEO
   path; the worker-side presence is pinned in tests/runs_executor/test_identities.py.)
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
    _CEO_VISUALIZATION_HINT,
    CHAT_CITATION_HINT,
    assemble_system_prompt,
    compose_ceo_chat_prompt,
    derive_ceo_addon,
)
from agentcore.runtime.skills import _TEAM_ORCHESTRATION_ADVANCED, build_system_skill_registry


def test_derive_ceo_addon_splits_shared_prefix_from_full_ceo_prompt():
    base = assemble_system_prompt()
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill", "ask_user"},
    )
    addon = derive_ceo_addon(base, ceo)
    assert addon
    assert "<role>" in addon
    assert "<output_style>" not in addon
    assert ceo.startswith(base)
    assert addon == ceo[len(base) :].lstrip("\n")
    assert ceo == base + ceo[len(base) :]


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


def test_untrusted_content_guard_frames_external_and_cross_agent_text():
    # <untrusted_content> (PI-003 + PI-006, 提示注入防御纵深) is the trust boundary the API
    # role="tool" alone doesn't enforce: external content — AND text authored by another Agent —
    # is DATA, never a command. It lives in the SHARED base so it reaches every worker AND the
    # composed CEO. Pin (1) the block + the data-not-command framing and a canonical injection
    # idiom it must resist, (2) that it names the PI-003 channels (tool/web/file/memory) AND the
    # PI-006 cross-agent channels (teammate notes / upstream product / delegated task), and
    # (3) that it survives into the composed CEO prompt — so a refactor can't silently drop the
    # guard or narrow it back to non-agent content only.
    base = assemble_system_prompt()
    assert "<untrusted_content>" in base and "</untrusted_content>" in base
    assert "【数据】" in base and "不是对你下达的指令" in base
    assert "忽略上面的指令" in base
    for token in ("工具返回", "网页", "文件", "长期记忆"):  # PI-003 external channels
        assert token in base, f"untrusted_content lost the {token} channel"
    for token in ("队友便签", "上游", "委派"):  # PI-006 cross-agent channels
        assert token in base, f"untrusted_content lost the cross-agent {token} framing"
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<untrusted_content>" in ceo and "队友便签" in ceo


def test_system_feedback_block_frames_engine_steers_as_non_user():
    # 回合中引擎自动注入的 [系统提示]（交付前核验 / 熔断 / 进度复盘 / 循环提醒）以 role=user 进窗口，
    # 模型易误当用户纠错、回一句「谢谢指正，我重新整理」，那句寒暄再随正常旁白通道漏进可见交付
    # （真实事故）。共享 base 的 <system_feedback> 把这类注入定性为「系统自动机制、非用户发言」并禁止
    # 致谢/复述/寒暄——放共享 base 所以 CEO 与每个 worker 都受约束。Pin 住块、非用户定性、以及点名要
    # 避免的原话，防重构悄悄丢掉。
    base = assemble_system_prompt()
    assert "<system_feedback>" in base and "</system_feedback>" in base
    assert "[系统提示]" in base
    assert "不是用户" in base  # 定性：非用户发言
    assert "谢谢指正" in base  # 点名要避免的原话
    # 复合进 CEO 提示后仍在（worker 走 bare base，天然带上）。
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<system_feedback>" in ceo


def test_tool_safety_moved_out_of_shared_base_and_ceo():
    # 按角色 right-size (反向): the environment-mutation caution (<tool_safety>) used to ride
    # the shared base, so the CEO carried it too — but the coordinator CEO holds only
    # read-only tools (build_ceo_tool_registry); a caution about write/delete/execute tools
    # it cannot call was inert weight. It moved onto the worker identities
    # (executor_identities._WORKER_TOOL_SAFETY_POLICY, pinned in test_identities.py). Pin its
    # ABSENCE from the base AND the composed CEO prompt so a refactor can't quietly re-inflate
    # the CEO prefix by folding it back into the shared base.
    base = assemble_system_prompt()
    assert "<tool_safety>" not in base
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<tool_safety>" not in ceo


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


def test_conversation_instructions_injected_above_memory():
    # 对话级自定义指令: a per-conversation directive rides the shared prefix as a
    # <对话级指令> block ABOVE the soft long-term memory <rules> (an explicit
    # instruction outranks auto-maintained preferences). Pin the block, its verbatim
    # text, AND the order so a refactor can't silently drop it or demote it below memory.
    out = assemble_system_prompt(
        memory_markdown="- 用户偏好简洁回复",
        instructions="始终用中文回答，先给结论再列依据",
    )
    assert "<对话级指令>" in out and "</对话级指令>" in out
    assert "始终用中文回答，先给结论再列依据" in out
    assert out.index("<对话级指令>") < out.index("<rules>")


def test_conversation_instructions_absent_when_blank():
    # Empty / whitespace-only instructions contribute nothing — the prefix stays
    # byte-identical to no-instructions so the DeepSeek exact-prefix cache holds.
    base = assemble_system_prompt()
    assert "<对话级指令>" not in base
    assert assemble_system_prompt(instructions="   ") == base


def test_conversation_instructions_reach_composed_ceo_prompt():
    # The block lives in the shared base (assemble_system_prompt), so it reaches BOTH
    # the bare worker base and the composed CEO prompt — the whole team obeys the
    # conversation's directive.
    base = assemble_system_prompt(instructions="用苏格拉底式提问引导我")
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "用苏格拉底式提问引导我" in ceo


def test_style_precedes_ceo_only_core_when_composed():
    # The CEO prompt is base + core hint (see pipeline.run_chat_pipeline). The
    # shared style must come from the base, independent of the CEO-only core.
    base = assemble_system_prompt()
    assert "<output_style>" in base
    assert "<output_style>" not in _CEO_CORE_HINT


def test_charting_detail_moved_out_of_worker_base():
    # 按角色 right-size: the DETAILED charting HOW (chart-type selection + mermaid /
    # markmap / vega-lite syntax) is CEO-only now — it must NOT ride the shared base,
    # or every delegated worker would carry ~500 tokens that mainly serve the
    # user-facing voice. Pin its absence so a refactor can't quietly re-inflate the
    # worker prompt by folding the detail back into the shared base.
    base = assemble_system_prompt()
    for token in ("mermaid", "markmap", "vega-lite"):
        assert token not in base, f"charting detail '{token}' leaked into the worker base"
    # The one-line affordance survives, so a doc-writing worker still knows charts render.
    assert "图表" in base


def test_visualization_block_rides_only_the_composed_ceo_prompt():
    # The moved charting HOW lives in the CEO-only <visualization> block and reaches
    # the model ONLY through compose_ceo_chat_prompt (the CEO path) — never the bare
    # base (the worker path). Pins the split end-to-end.
    assert "<visualization>" in _CEO_VISUALIZATION_HINT
    assert "mermaid" in _CEO_VISUALIZATION_HINT

    base = assemble_system_prompt()
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<visualization>" in ceo  # CEO carries the detailed charting HOW…
    assert "mermaid" in ceo
    assert "<visualization>" not in base  # …workers (base only) do not.


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
    # multi-part deliverable into one worker are deviations. The always-on core keeps
    # the forward spine; the reverse guards (don't over-split / don't under-team) moved
    # to team_orchestration_advanced (P3) — so a refactor can't quietly revert to a
    # single-direction「别拆碎」brake.
    hint = _CEO_CORE_HINT
    assert "独立" in hint and "并行" in hint and "专长" in hint
    assert "不是数量本身" in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "能就不拆" in skill  # over-splitting guard
    assert "你已确认需要多 worker" in skill  # under-teaming guard


def test_skill_teaches_same_layer_pipeline():
    # A multi-stage pipeline is a DAG within ONE delegate call (depends_on, same
    # layer) — moved to team_orchestration_advanced (P3). The nesting axis
    # (can_delegate) lives in the same skill.
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "depends_on" in skill
    assert "同一层" in skill


def test_core_teaches_delegating_parallel_research():
    # C: deliverable-scale research that spans independent angles is TEAM work — the
    # CEO must fan it out to parallel research workers (which hold retrieval tools too),
    # not run all retrieval serially itself and delegate only the writing (the
    # 「调研收归 CEO 串行」 regression seen in the law conversation). Its own retrieval
    # stays for direct answers / light orientation (探路), not the deliverable's legwork.
    hint = _CEO_CORE_HINT
    assert "广度调查" in hint
    assert "探路" in hint


def test_core_reminds_pass_hidden_context_to_worker():
    # A worker never sees the conversation history, so the CEO must write the
    # decision's key assumptions / constraints into the task itself.
    hint = _CEO_CORE_HINT
    assert "看不到" in hint
    assert "对话历史" in hint


def test_skill_teaches_constraint_vs_solution_boundary():
    # 认知分工边界（约束 vs 方案）: the CEO writes requirements/constraints into the
    # task, but leaves the deliverable's professional STRUCTURE (a paper's chapters /
    # argument, a codebase's architecture) to the expert worker — unless the user
    # fixed it. Moved to team_orchestration_advanced (P3). Pins the fix for the
    # 「CEO 替专家把方案定死、worker 沦为填字员」regression (法律论文案例).
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "专业方案" in skill
    assert "填字员" in skill


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
