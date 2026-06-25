"""Tests for the legal vertical v0 domain Skill (法律垂直「答辩状作战室」).

Guards three things:
1. Opt-in gating — ``legal_answer_brief`` is ABSENT from the default registry and
   PRESENT only with ``include_legal=True`` (so generic deployments never see legal
   content; the platform system-skill set in test_skills.py stays exactly the 6).
2. consult_skill resolves it (CEO can pull the full guidance) when registered, and
   the 能力目录 lists it when its required tools are wired.
3. The body still teaches its mechanism — the war-room orchestration (delegate +
   debate red_team with is_subject) and the anti-hallucination floor — so it can't
   silently rot into a generic "write a brief" prompt.
"""

from pathlib import Path

from agentcore.runtime.legal_skills import LEGAL_SKILLS
from agentcore.runtime.skills import build_system_skill_registry, render_skill_directory
from agentcore.tools.builtin.consult_skill import ConsultSkillTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

# legal_answer_brief gates on delegate + debate (both wired on the CEO path).
_FULL_TOOLS = {"delegate", "revise", "ask_user", "debate"}


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


# --- opt-in gating -----------------------------------------------------------


def test_legal_skill_absent_by_default():
    # Default (include_legal=False): the platform set only — no legal pollution.
    reg = build_system_skill_registry()
    assert reg.get("legal_answer_brief") is None


def test_legal_skill_present_when_opted_in():
    reg = build_system_skill_registry(include_legal=True)
    skill = reg.get("legal_answer_brief")
    assert skill is not None
    assert skill.requires_tools == ("delegate", "debate")


def test_legal_skill_layers_onto_the_platform_set():
    # include_legal adds the legal pack ON TOP of the 6 system skills, same registry.
    base = {s.name for s in build_system_skill_registry().list_all()}
    full = {s.name for s in build_system_skill_registry(include_legal=True).list_all()}
    assert full - base == {s.name for s in LEGAL_SKILLS}
    assert "team_orchestration_advanced" in full  # platform skills still there


# --- catalog + consult -------------------------------------------------------


def test_directory_lists_legal_skill_when_enabled_and_tools_wired():
    reg = build_system_skill_registry(include_legal=True)
    out = render_skill_directory(reg, _FULL_TOOLS)
    assert "- legal_answer_brief：" in out


async def test_consult_resolves_legal_skill_when_enabled():
    reg = build_system_skill_registry(include_legal=True)
    tool = ConsultSkillTool(registry=reg)
    result = await tool.execute({"name": "legal_answer_brief"}, _ctx())
    assert result.success
    assert result.output == reg.get("legal_answer_brief").body


# --- body teaches the mechanism ---------------------------------------------


def _body() -> str:
    return build_system_skill_registry(include_legal=True).get("legal_answer_brief").body


def test_body_teaches_war_room_red_team_orchestration():
    # hero = 对方律师作战室: delegate 起草/核验/格式 + debate(red_team, is_subject) 原告红队。
    body = _body()
    assert "delegate" in body
    assert "debate" in body and "red_team" in body and "is_subject" in body
    assert "原告红队" in body  # the adversary that single-agent can't fake


def test_body_teaches_answer_brief_structure():
    body = _body()
    assert "答辩状" in body
    assert "程序" in body and "实体" in body  # 程序性 / 实体性抗辩
    assert "质证" in body


def test_body_enforces_anti_hallucination_floor():
    # 真交付律师档位的底线：未核验不得引法条 / 标法域 / 免责 / 人审闸门。
    body = _body()
    assert "核验" in body and "不得" in body
    assert "中国大陆法" in body
    assert "免责" in body
    assert "checkpoint_after" in body or "人审" in body
