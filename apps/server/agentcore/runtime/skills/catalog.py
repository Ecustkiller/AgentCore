"""Thin registry assembly + 按需目录 rendering for system skills."""

from __future__ import annotations

from agentcore.runtime.skills.data_file_landing import _DATA_FILE_LANDING
from agentcore.runtime.skills.debate_and_review import _DEBATE_AND_REVIEW
from agentcore.runtime.skills.delivery import _DELIVERY
from agentcore.runtime.skills.local_desk import _LOCAL_DESK
from agentcore.runtime.skills.page_ui import _PAGE_UI
from agentcore.runtime.skills.product_help import build_product_help_body
from agentcore.runtime.skills.registry import (
    AUDIENCE_CEO_ONLY,
    GROUP_DELIVERY,
    GROUP_ORCHESTRATION,
    GROUP_PRODUCT,
    GROUP_TOOLS,
    GROUP_WORKSPACE,
    SkillRegistry,
    SystemSkill,
)
from agentcore.runtime.skills.run import _RUN

# --- The system skills (single source of truth) -----------------------------
# Catalog summaries: name-like (what this is), not a 19-way scene classifier.
# Python len ≤80; HOW lives in the body. ``blurb`` is toolbox-card only.
_SYSTEM_SKILLS: tuple[SystemSkill, ...] = (
    SystemSkill(
        name="debate_and_review",
        summary="正反辩论",
        blurb="正反两边对碰，再收到一个可拍板的结论",
        body=_DEBATE_AND_REVIEW,
        requires_tools=("debate",),
        group=GROUP_ORCHESTRATION,
    ),
    SystemSkill(
        name="local_desk",
        summary="本机目录进工作区",
        blurb="把这台电脑上的文件夹接到当前工作区",
        body=_LOCAL_DESK,
        audience=AUDIENCE_CEO_ONLY,
        group=GROUP_WORKSPACE,
    ),
    SystemSkill(
        name="delivery",
        summary="交付环境",
        blurb="东西交到哪里、以什么形态交给人",
        body=_DELIVERY,
        audience=AUDIENCE_CEO_ONLY,
        group=GROUP_DELIVERY,
    ),
    SystemSkill(
        name="data_file_landing",
        summary="整理表",
        blurb="把数据文件整理成打开扫得懂的表",
        body=_DATA_FILE_LANDING,
        # Consult is CEO+worker. Body is the worker loop; CEO still consults to brief.
        # Do not gate on ``run``: this turn may have no execution assembled; the
        # brief still belongs in the supervisor catalog.
        group=GROUP_DELIVERY,
    ),
    SystemSkill(
        name="page_ui",
        summary="页面观感",
        blurb="页面长什么样、交互怎么铺",
        body=_PAGE_UI,
        # CEO+worker：主管把方向写进 task，工人铺像素。无工具门。
        group=GROUP_DELIVERY,
    ),
    SystemSkill(
        name="product_help",
        summary="本产品用法",
        blurb="这个产品能做什么、入口在哪",
        body=build_product_help_body(),
        audience=AUDIENCE_CEO_ONLY,
        group=GROUP_PRODUCT,
    ),
    SystemSkill(
        name="run",
        summary="跑命令 / 启服",
        blurb="在终端跑命令、起本地服务",
        body=_RUN,
        requires_tools=("run",),
        group=GROUP_TOOLS,
    ),
)


def build_system_skill_registry() -> SkillRegistry:
    """Register the platform's built-in (system) skills — the single source of truth.

    Mirrors ``build_builtin_registry`` for tools: code-defined, always available to
    the CEO via ``consult``. Domain SOPs (法律等) are first-party store SKUs, not
    layered into this registry.
    """
    registry = SkillRegistry()
    for skill in _SYSTEM_SKILLS:
        registry.register(skill)
    return registry


def render_skill_directory(registry: SkillRegistry, tool_names: set[str]) -> str:
    """Backward-compat wrapper → unified ``<按需目录>`` (skills only).

    Prefer building entries via :class:`MergedConsultSource` so directory and
    ``consult`` fetch cannot drift. Kept for tests / capability catalog that only
    need the skill slice.
    """
    from agentcore.runtime.context.consultable import ConsultDirectoryEntry
    from agentcore.runtime.resolve.prompt.compose import render_on_demand_directory

    skills = registry.available(tool_names)
    if not skills:
        return ""
    entries = [
        ConsultDirectoryEntry(
            name=skill.name,
            summary=skill.summary,
            section="skill",
            group=skill.group,
        )
        for skill in skills
    ]
    return render_on_demand_directory(entries, with_summaries=True)
