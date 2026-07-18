"""Tests for system Skills + consult_skill (提示词瘦身 P2 — 渐进披露).

Covers the three moving parts of the prompt-slimming slice:

1. ``SkillRegistry`` / ``build_system_skill_registry`` — name lookup (hit/miss) and
   the ``requires_tools`` visibility filter.
2. ``render_skill_directory`` — the always-on 能力目录 lists only skills whose required
   tools are wired this turn (so it never advertises a capability the CEO lacks).
3. ``ConsultSkillTool`` — returns a skill's full body (CONTINUE) on a hit, and
   degrades gracefully (non-fatal, lists names) on an unknown name.

Plus a guard that each skill BODY still teaches the mechanism it owns — the
assertions that used to pin these in the always-on CEO hint, now relocated to the
skills they were externalised into.
"""

from pathlib import Path

from agentcore.core.types import ToolCategory
from agentcore.runtime.skills import (
    SkillRegistry,
    SystemSkill,
    build_system_skill_registry,
    render_skill_directory,
)
from agentcore.tools.builtin.consult_skill import ConsultSkillTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

# debate / delegate are wired on every path; ask_user is live-user only.
# verify_and_fix / long_form_writing / team_orchestration_advanced ride delegate.
_FULL_TOOLS = {"delegate", "ask_user", "debate"}
_NO_LIVE_USER = {"delegate", "debate"}  # autonomous path: no ask_user


def _ctx() -> ToolContext:
    # consult_skill never touches the backend; a real one only satisfies the shape.
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


# --- registry ----------------------------------------------------------------


def test_registry_registers_the_system_skills():
    reg = build_system_skill_registry()
    names = {s.name for s in reg.list_all()}
    assert names == {
        "team_orchestration_advanced",
        "debate_and_review",
        "revising_a_product",
        "ask_user_kickoff",
        "ask_user_midtask",
        "delegate_checkpoint",
        "verify_and_fix",
        "long_form_writing",
    }


def test_registry_get_hit_and_miss():
    reg = build_system_skill_registry()
    assert reg.get("debate_and_review") is not None
    assert reg.get("no_such_skill") is None


def test_registry_rejects_duplicate_name():
    reg = SkillRegistry()
    reg.register(SystemSkill(name="x", summary="s", body="b"))
    try:
        reg.register(SystemSkill(name="x", summary="s2", body="b2"))
    except ValueError:
        pass
    else:  # pragma: no cover - the register must raise
        raise AssertionError("duplicate skill name should raise ValueError")


def test_available_hides_gated_skills_without_required_tools():
    # The ask_user_* skills (and delegate_checkpoint, which pauses for user review)
    # need the ask_user tool. On the autonomous (no live user) path it is not wired,
    # so those skills drop out of the catalog. verify_and_fix rides delegate (the
    # delegated dev loop), so it stays available on the autonomous path.
    reg = build_system_skill_registry()
    available = {s.name for s in reg.available(_NO_LIVE_USER)}
    assert "team_orchestration_advanced" in available
    assert "debate_and_review" in available
    assert "revising_a_product" in available
    assert "verify_and_fix" in available
    assert "ask_user_kickoff" not in available
    assert "ask_user_midtask" not in available
    assert "delegate_checkpoint" not in available


def test_available_shows_gated_skills_when_tools_wired():
    reg = build_system_skill_registry()
    available = {s.name for s in reg.available(_FULL_TOOLS)}
    assert "ask_user_kickoff" in available
    assert "ask_user_midtask" in available
    assert "delegate_checkpoint" in available
    assert "verify_and_fix" in available


# --- directory rendering -----------------------------------------------------


def test_directory_lists_only_available_skills_with_names_and_summaries():
    reg = build_system_skill_registry()
    out = render_skill_directory(reg, _FULL_TOOLS)
    assert "<能力目录>" in out and "</能力目录>" in out
    assert "consult_skill" in out  # the soft push to pull a skill
    for skill in reg.list_all():
        assert skill.name in out
        assert skill.summary in out


def test_directory_omits_gated_skills_on_autonomous_path():
    reg = build_system_skill_registry()
    out = render_skill_directory(reg, _NO_LIVE_USER)
    assert "ask_user_kickoff" not in out
    assert "ask_user_midtask" not in out
    assert "delegate_checkpoint" not in out
    # The delegate-gated + non-gated advanced skills are still offered.
    assert "team_orchestration_advanced" in out
    assert "verify_and_fix" in out


def test_directory_empty_when_nothing_available():
    # A registry whose every skill is gated behind an un-wired tool renders nothing,
    # so the caller appends nothing (no empty <能力目录> block).
    reg = SkillRegistry()
    reg.register(SystemSkill(name="x", summary="s", body="b", requires_tools=("missing_tool",)))
    assert render_skill_directory(reg, set()) == ""


# --- consult_skill tool ------------------------------------------------------


def test_consult_skill_schema_is_ceo_orchestration_primitive():
    # consult_skill is a CEO orchestration primitive (not a「技能」-category tool):
    # 技能 are Prompt injection shown in the「AI 提示词」catalog, never a tool group.
    tool = ConsultSkillTool(registry=build_system_skill_registry())
    schema = tool.schema
    assert schema.name == "consult_skill"
    assert schema.category is ToolCategory.ORCHESTRATION


async def test_consult_skill_returns_body_on_hit():
    reg = build_system_skill_registry()
    tool = ConsultSkillTool(registry=reg)
    result = await tool.execute({"name": "debate_and_review"}, _ctx())
    assert result.success
    assert result.output == reg.get("debate_and_review").body


async def test_consult_skill_degrades_on_unknown_name():
    tool = ConsultSkillTool(registry=build_system_skill_registry())
    result = await tool.execute({"name": "bogus"}, _ctx())
    assert not result.success
    # Graceful: lists the available names so the model can retry (no turn-breaking).
    assert "team_orchestration_advanced" in result.output


async def test_consult_skill_handles_missing_name_arg():
    tool = ConsultSkillTool(registry=build_system_skill_registry())
    result = await tool.execute({}, _ctx())
    assert not result.success


# --- skill bodies still teach their mechanisms (relocated from the CEO hint) --


def _body(name: str) -> str:
    return build_system_skill_registry().get(name).body


def test_team_orchestration_skill_teaches_shape_vocabulary():
    # 协作优先重设计阶段 2：skill 教形状词汇表 + 组合规则 + 三档，playbook 降为教学示例。
    body = _body("team_orchestration_advanced")
    for term in (
        "并列对象分组",
        "角度扇出",
        "证据驱动流水线",
        "独立审查",
        "有界返工环",
        "契约共享面",
        "独立多透镜诊断",
        "部件一致性对账",
        "对抗辩论",
        "发散挑选",
    ):
        assert term in body, term
    assert "默认中档" in body
    assert "教学示例形状" in body and "对照学形状" in body
    assert "免手搓" not in body  # 旧广告口径已撤
    assert "research_report" in body  # listing still present as teaching examples


def test_team_orchestration_skill_teaches_delegate_knobs():
    # Relocated from the old always-on hint: cost tier, quality contract, output
    # shaping, finalize, the DAG-vs-nesting distinction.
    body = _body("team_orchestration_advanced")
    assert "fast" in body and "strong" in body
    assert "deliverable" in body
    assert "finalize" in body
    assert "coordinate" in body and "coordinate=false" in body
    assert "depends_on" in body and "同一层" in body
    assert "嵌套委派" in body and "大模块" in body
    # 协调补派失败节点须标 replaces_run_id，引擎改写下游 depends_on
    assert "replaces_run_id" in body and "补派" in body
    # 纠正「一次只能一个 delegate / 同步阻塞到全队完成」误述：一回合一张图 + 同回合可再追加
    assert "一回合一张协作图" in body
    assert "再调" in body and "delegate" in body
    assert "不必" in body or "不是" in body  # 否定「必须等全队完成」


def test_team_orchestration_skill_teaches_constraint_vs_solution_and_outline_step():
    # 认知分工 + 结构跟着证据走（L3/L4，法律论文案例的根因修复）: the skill teaches that
    # a deliverable's professional STRUCTURE belongs to the expert worker (not the
    # CEO's task), that contract.required_sections is an acceptance floor (not a
    # structure blueprint), and that研究级大型交付 should make「定结构」an evidence-driven,
    # user-gated outline step (调研 → 提纲 + checkpoint_after → 全文) rather than the
    # CEO fixing the skeleton up front. Pins the范式 so it can't silently drop out.
    body = _body("team_orchestration_advanced")
    assert "方案" in body  # 约束 vs 方案
    assert "required_sections" in body  # 验收底线、非结构蓝图
    assert "提纲" in body
    assert "checkpoint_after" in body


def test_team_orchestration_skill_teaches_parallel_review_notewall():
    # 并行审查须经 post_note 广播方向级问题（便签墙），再各自挑细节。
    # 决策现状见 docs/03-AI核心/Agent协作模式.md（波内共享上下文 / 便签墙）。
    body = _body("team_orchestration_advanced")
    assert "post_note" in body and "heads_up" in body
    assert "并行审查" in body or "并行" in body


def test_team_orchestration_skill_teaches_review_contract_template():
    # 审查默认 prose + 中文 required_sections；结构化 JSON 仅走文件通道（artifacts）。
    # 钉：格式只在 deliverable、task 不双写、勿混用 json+required_sections、web_search 软引导。
    body = _body("team_orchestration_advanced")
    assert "审查类任务的统一契约" in body
    assert "默认 prose" in body
    assert 'required_sections": ["问题", "建议", "评分"]' in body
    assert "结构化交付走文件通道" in body
    assert "artifacts" in body and "output_format" in body and "json" in body
    assert "禁止" in body  # 混用防御
    assert "web_search" in body
    assert "全文" in body or "复制" in body
    assert "deliverable" in body
    assert "custom" in body and "不被引擎验证" in body
    assert "problems" in body and "suggestions" in body and "score" in body


def test_team_orchestration_skill_teaches_seed_notes_and_team_brief():
    body = _body("team_orchestration_advanced")
    assert "seed_notes" in body and "team_brief" in body
    assert 'coordination="wall"' in body or "coordination" in body
    assert "wall" in body and "none" in body
    assert "正交" in body or "互不依赖" in body


def test_team_orchestration_skill_teaches_coordination_wall_vs_none():
    body = _body("team_orchestration_advanced")
    assert "coordination" in body
    assert "wall" in body and "none" in body
    assert "build_feature" in body


def test_debate_skill_teaches_debate_tool_forms_and_dual_products():
    # 重构后辩论是独立的 `debate` 工具（主持人驱动），不再是 delegate 上的 stance/round 标记。
    # skill 教三形态选择、参与方配置、主持人自调轮数、双产物、与 delegate / ask_user 的边界。
    body = _body("debate_and_review")
    assert "debate" in body and "辩论" in body
    # 三形态 + 红队被审方
    assert "red_team" in body and "roundtable" in body
    assert "is_subject" in body
    # 你只定命题与参与方；轮数由主持人自调
    assert "motion" in body and "sides" in body
    # 双产物
    assert "决策简报" in body and "交锋叙事线" in body
    # 边界：并行调研仍用 delegate；收尾价值之争交 ask_user
    assert "delegate" in body and "ask_user" in body
    # 收尾铁律：别抹平证据状态 + 不引入场外量化（与 to_ceo_output 尾部同口径）
    assert "别抹平证据状态" in body or "既定事实" in body
    assert "不引入场外量化" in body
    assert "量化估算" in body


def test_debate_skill_teaches_intent_alignment_before_opening():
    # §四 意图对齐（法律辩论案例的根因修复）: before opening a debate the CEO must stay
    # faithful to the user's framing — cover every pole the user named (don't silently
    # drop / swap the「减轻」pole for a milder「审慎派」), and clarify an ambiguous
    # reference the debate hinges on (「最近很火的那个」) via ask_user rather than picking
    # one reading and diving in. Pins the范式 so it can't silently regress.
    body = _body("debate_and_review")
    # ① 忠于用户点名的对立极：不得砍掉 / 偷换一极
    assert "对立极" in body
    assert "偷换" in body
    # ② 关键指代模糊先澄清，用 ask_user 确认，而非自挑一解开辩
    assert "先澄清" in body
    assert "ask_user" in body


def test_debate_skill_teaches_thin_stance():
    # stance 薄约束：CEO 只写一句立场倾向，禁预写论点大纲 / 论证角度指令。
    # schema + Skill 对称于 background 的硬边界；防「开辩前替辩手写论证剧本」回退。
    from agentcore.tools.builtin.debate.schema import DEBATE_PARAMETERS

    body = _body("debate_and_review")
    assert "立场倾向" in body
    assert "约 30" in body or "30 字" in body
    assert "支持一审判决正确" in body or "判赔过重" in body
    assert "核心论点" in body or "系统论证" in body
    assert "background" in body
    assert "剧本" in body or "工作产出" in body

    stance_desc = DEBATE_PARAMETERS["properties"]["sides"]["items"]["properties"]["stance"][
        "description"
    ]
    assert "一句立场倾向" in stance_desc
    assert "约 30" in stance_desc or "30 字" in stance_desc
    assert "background" in stance_desc
    assert "核心论点" in stance_desc or "系统论证" in stance_desc


def test_debate_skill_teaches_background_for_concrete_cases():
    # 赛前底料引导：具体案件 / 真实事件类命题建议传 background（3–5 条客观事实），
    # 纯价值观命题不必——避免双方重复检索同一批底料。Pins the引导措辞。
    body = _body("debate_and_review")
    assert "background" in body
    assert "具体案件" in body or "真实事件" in body
    assert "客观事实" in body
    assert "不必传" in body or "不必" in body


def test_revise_skill_teaches_recall_and_delegate_fallback():
    body = _body("revising_a_product")
    assert "continue_from_run_id" in body
    assert "delegate" in body
    # The fallback boundary: 换角色 / 救失败稿 / 合并 → 冷委派 + replaces_run_id.
    assert "冷委派" in body and "replaces_run_id" in body
    assert "补派" in body or "接手" in body


def test_ask_user_kickoff_skill_teaches_impact_tiered_proposal_card():
    # 开场提案卡 split out of the formerly-merged asking_the_user skill: impact-tiered
    # card content, gated on the ask_user tool (live-user only). The checkpoint detail
    # must NOT ride here — it moved to its own delegate_checkpoint skill.
    skill = build_system_skill_registry().get("ask_user_kickoff")
    assert skill.requires_tools == ("ask_user",)
    body = skill.body
    assert "assumptions" in body
    assert "questions" in body
    assert "style_options" in body
    assert "影响" in body  # 影响力分档
    assert "开工提案卡" in body
    assert "checkpoint_after" not in body


def test_ask_user_midtask_skill_teaches_fork_annotate_and_nonblocking():
    # 途中拍板 split: the mid-task fork + 何时不打断 (proceed-and-annotate) + the
    # non-blocking ask + debate closing handed to the user. Gated on ask_user; the
    # checkpoint mechanism is now its own skill, not part of midtask.
    skill = build_system_skill_registry().get("ask_user_midtask")
    assert skill.requires_tools == ("ask_user",)
    body = skill.body
    assert "采纳正方" in body  # debate closing handed to the user
    assert "假设" in body and "若不符请指正" in body  # proceed-and-annotate
    assert "blocking=false" in body  # the non-blocking ask
    assert "checkpoint_after" not in body


def test_delegate_checkpoint_skill_teaches_wave_boundary_pause():
    # 委派波间挂起 split out: the checkpoint_after wave-boundary pause. Gated on
    # ask_user (the live-user proxy) since it pauses for user review.
    skill = build_system_skill_registry().get("delegate_checkpoint")
    assert skill.requires_tools == ("ask_user",)
    body = skill.body
    assert "checkpoint_after" in body
    assert "depends_on" in body  # only meaningful inside a multi-step DAG


def test_verify_and_fix_skill_teaches_test_run_loop():
    skill = build_system_skill_registry().get("verify_and_fix")
    # Gated on delegate (the delegated dev loop), not test_run — test_run is now a
    # worker-only execution tool and consult_skill is CEO-only, so gating on it would
    # make the skill un-advertisable. The body still teaches the test_run → fix loop.
    assert skill.requires_tools == ("delegate",)
    body = skill.body
    assert "test_run" in body
    assert "str_replace" in body
    assert "escalate" in body


def test_long_form_writing_skill_teaches_segmented_append():
    skill = build_system_skill_registry().get("long_form_writing")
    assert skill.requires_tools == ("delegate",)
    body = skill.body
    assert "file_write" in body
    assert "file_append" in body
    assert "大纲" in body
