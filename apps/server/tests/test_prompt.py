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

from agentcore.runtime.resolve.prompt import (
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
    # 协作优先重设计阶段 2：组队门槛 = 可分解或质量面；形状从任务自然结构推导。
    # 判据仍是结构（独立可并行 / 专长 / 多部件），NOT 任务数量；旧「能就不拆」已推翻。
    hint = _CEO_CORE_HINT
    assert "独立" in hint and "并行" in hint and "专长" in hint
    assert "不是你能不能写" in hint  # 判据=结构，「我自己写更快」不构成直答理由
    assert "拿不准也组队" in hint
    assert "可分解" in hint and "质量面" in hint
    assert "finalize=true" in hint and "机械单步" in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "形状词汇" in skill
    assert "实质任务默认组队" in skill
    assert "教学示例形状" in skill and "对照学形状" in skill
    assert "免手搓" not in skill  # 旧「是就直接套 / 免手搓」广告口径已撤
    assert "并列对象分组" in skill and "独立多透镜诊断" in skill
    assert "实现+独立验证" in skill  # 构建轻档双人底线


def test_core_teaches_delegate_graph_and_coordinate_invariants():
    # 产品 AI 自述委派机制时曾误称「一次只能一个 delegate、同步阻塞」。
    # 常驻 core 钉：一回合一张图 + 默认协调非阻塞 + 同回合可再追加。
    hint = _CEO_CORE_HINT
    assert "一回合一张协作图" in hint
    assert "coordinate=false" in hint
    assert "不必等上一批全部完成" in hint
    assert "立即返回" in hint

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
    # 审查 / 评估类「指路不代答」：初审线索走便签，不写进 task 替答。
    assert "seed_notes" in skill and "heads_up" in skill
    assert "引导性问题" in skill or "风险预判" in skill


def test_core_teaches_delegate_point_dont_answer():
    # 派单「指路不代答」: 仅禁施工图打不到审查类越界——编号关注清单 / 风险预判 /
    # 引导性问题 / 专业知识代查会把 worker 降成初审扩写器；线索走 seed_notes heads_up。
    hint = _CEO_CORE_HINT
    assert "目标·约束·验收" in hint
    assert "施工图" in hint and "答题纸" in hint
    assert "风险结论" in hint or "预判" in hint
    assert "引导性问题" in hint
    assert "seed_notes" in hint and "heads_up" in hint


def test_core_teaches_execution_and_recall_routing():
    # 环境事实驱动：本机任务在云端时先 ask_user（bind_local_folder），已在本机则委派验收；
    # 「刚才产出」须先核实工作区。
    hint = _CEO_CORE_HINT
    assert "【执行 / 运行 / 打开】" in hint
    assert "workspace_context" in hint
    assert "不要先委派" in hint
    assert "bind_local_folder" in hint
    assert "completion_criteria=code_verified" in hint
    assert "【回忆 / 核实产出】" in hint
    assert "file_list" in hint
    assert "口头拒绝" in hint


def test_core_guides_out_of_workspace_absolute_paths():
    # 引用即驻留 + W3 目录授权：CEO 见区外路径时按单文件/目录分流。
    hint = _CEO_CORE_HINT
    assert "【工作区外路径 / 本机绝对路径】" in hint
    assert "不要" in hint and "硬读" in hint
    assert "ask_user" in hint
    assert "attachments/" in hint
    assert "回形针" in hint or "@" in hint
    assert "grant_readonly_folder" in hint
    assert "grant_organize_folder" in hint
    assert "organize_plan" in hint
    assert "external/" in hint
    assert "只读" in hint


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
