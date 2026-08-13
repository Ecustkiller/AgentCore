"""Compose / assemble system prompts from prompt fragments."""

import time
from collections.abc import Sequence

from agentcore.runtime.context import ContextAssembler, SectionOrder
from agentcore.runtime.context.consultable import ConsultDirectoryEntry
from agentcore.runtime.context.folder_catalog import (
    FolderCatalogEntry,
    render_folder_catalog,
)
from agentcore.runtime.resolve.profile import (
    FRAGMENT_BASE,
    FRAGMENT_CEO_CORE,
    FRAGMENT_CEO_VISUALIZATION,
    FRAGMENT_CITATION,
    resolve,
)
from agentcore.runtime.resolve.prompt.base import (
    _DEFAULT_SYSTEM_PROMPT,
    _RUNTIME_CONTEXT_TEMPLATE,
)
from agentcore.runtime.resolve.prompt.ceo_core import (
    _CEO_CORE_HINT,
    _PROMOTE_PRODUCT_TOOL_HINT,
)
from agentcore.runtime.resolve.prompt.citation import CHAT_CITATION_HINT
from agentcore.runtime.resolve.prompt.cold_start import (
    _FOLDER_NAV_STALE_HINT,
    _FOLDER_PROFILE_EMPTY_SOFT_HINT,
    _FOLDER_PROFILE_TOOL_HINT,
    _explore_act_block,
)
from agentcore.runtime.resolve.prompt.memory_rules import _format_rules
from agentcore.runtime.resolve.prompt.visualization import _CEO_VISUALIZATION_HINT
from agentcore.runtime.skills.product_help import (
    CONSULT_PRODUCT_BUG_TRIAGE_BY_SCENE,
    CONSULT_PRODUCT_HELP_BY_SCENE,
)
from agentcore.runtime.skills.team_orchestration import CONSULT_TEAM_ORCH_BY_SCENE


def assemble_system_prompt(
    *,
    rules_markdown: str | None = None,
    extra_context: str | None = None,
    workspace_context: str | None = None,
) -> str:
    """Build the system prompt for a conversation.

    ``rules_markdown`` is the always-on equal-authority join of user rules + AI memory
    core (Agent记忆与知识系统 · 取消权威档). When non-empty it becomes ONE ``<rules>``
    block — no user-hard / AI-soft subsections. This base prompt is shared by the CEO
    chat agent and the delegated workers (runs/executor/), so both reach every agent.

    ``workspace_context`` is the per-turn ``<workspace_context>`` environment-facts
    block (execution location / desktop channel / capabilities) — injected into the
    SHARED base so workers also see where they run (防止空云 scratch 里幻觉装软件).

    Sections are stitched by :class:`ContextAssembler` (上下文注入统一): base →
    runtime context → workspace facts → memory <rules> → attachment context, joined
    with "\n". Empty optional sections (memory, attachments, workspace facts) are
    skipped. Without ``workspace_context`` the output stays byte-identical to the
    prior assembly — load-bearing for DeepSeek prefix-cache stability when the
    caller omits facts (catalog / tests).

    The ``base`` fragment goes through ``resolve.profile.resolve`` (方向① 变体注入): with no
    active profile — the production state always — it returns ``_DEFAULT_SYSTEM_PROMPT``
    verbatim, so the prefix is unchanged; an eval may swap it via ``use_profile`` to A/B
    the shared base. A base override reaches both workers and the CEO (whose base_prompt
    is this function's output).
    """
    runtime_context = _RUNTIME_CONTEXT_TEMPLATE.format(
        date=time.strftime("%Y-%m-%d %Z", time.localtime())
    )
    return (
        ContextAssembler()
        .add("base", resolve(FRAGMENT_BASE, _DEFAULT_SYSTEM_PROMPT), SectionOrder.BASE)
        .add("runtime_context", runtime_context, SectionOrder.RUNTIME_CONTEXT)
        .add("workspace_facts", workspace_context, SectionOrder.WORKSPACE_FACTS)
        .add(
            "memory_rules",
            _format_rules(rules_markdown),
            SectionOrder.MEMORY,
        )
        .add("attachment_context", extra_context, SectionOrder.ATTACHMENT)
        # D4 前缀缓存归因: 本层的段会被上层当作一整段收进去, 只有各层都登记, 击穿点才能归到叶段
        # (如 memory_rules / workspace_facts) 而不是笼统的「CEO 提示变了」。只登记不改装配。
        .track_sections(scope="shared_base")
        .render()
    )


def _on_demand_preamble(*, with_summaries: bool) -> list[str]:
    """Shared intro lines for ``<按需目录>`` (CEO gets summaries; worker names-only)."""
    detail = "name＋一行摘要" if with_summaries else "name"
    return [
        "<按需目录>",
        f"下列按需条目（仅列{detail}、全文未常驻）可用 `consult(name)` 拉取："
        "系统能力指引、按需用户规则、记忆主题笔记。常驻内容已在 ``<rules>``，无需查阅。"
        f"（{CONSULT_PRODUCT_HELP_BY_SCENE}；"
        f"{CONSULT_PRODUCT_BUG_TRIAGE_BY_SCENE}；"
        "提问卡直接 ask_user、不必先查；"
        f"组队进阶：{CONSULT_TEAM_ORCH_BY_SCENE}；"
        "糊建站 /「做个网站」先 ask_user（形态+桌上档），确认后再 consult `build_website`；"
        "规格已齐的落地页/作品集可直接 delegate(playbook=build_website, "
        "playbook_args.topic=简述, intensity=solo|standard)，不必先查；"
        "控制台 / 后台 / 工具台 dense 用 build_website + style=toolshed（同 consult `build_website`）；"
        "绿场【推荐】build_app（手写/none 不硬拒）：MVP→lean；模块流水线→full+显式 modules；"
        "边界未钉 → 首派轻切片/少节点或单 lead 嵌套再拆，再 replan，禁首派五波脚手架；"
        "做软件禁止单前端单 HTML 薄旁路（局部可手写多角色或选用 build_feature））：",
    ]


def render_on_demand_directory(
    entries: Sequence[ConsultDirectoryEntry],
    *,
    with_summaries: bool = True,
) -> str:
    """Render the unified ``<按需目录>`` block (CEO: name＋摘要；worker: names only).

    Returns "" when empty so the caller appends nothing (directory↔tool: only when
    ``consult`` is wired this turn). Entries must come from the same
    :class:`~agentcore.runtime.context.consult_sources.MergedConsultSource` the tool holds.
    """
    if not entries:
        return ""
    lines = _on_demand_preamble(with_summaries=with_summaries)
    if with_summaries:
        lines.extend(
            f"- {e.name}：{e.summary}" if e.summary else f"- {e.name}" for e in entries
        )
    else:
        lines.extend(f"- {e.name}" for e in entries)
    lines.append("</按需目录>")
    return "\n".join(lines)


def compose_worker_base_prompt(
    shared_base: str,
    *,
    on_demand_entries: Sequence[ConsultDirectoryEntry] = (),
    attachment_context: str | None = None,
    # Deprecated kwargs kept so older call sites / tests fail loudly if still passed
    # with old semantics — prefer ``on_demand_entries``.
    memory_topics: Sequence[object] = (),
    memory_enabled: bool = True,
    on_demand_rules: Sequence[object] = (),
) -> str:
    """Build the delegated worker's system prompt from the shared base.

    Layers the worker simplified ``<按需目录>`` (names only) when ``on_demand_entries``
    is non-empty, then the per-turn attachment block last (缓存友好).
    """
    del memory_enabled  # gate is has_entries at wire time; entries already filtered
    if on_demand_entries:
        entries = on_demand_entries
    elif memory_topics or on_demand_rules:
        # Legacy bridge: convert old topic/rule lists (tests mid-migration).
        entries = [
            ConsultDirectoryEntry(
                name=getattr(t, "name", str(t)),
                summary=getattr(t, "summary", "") or "",
            )
            for t in (*memory_topics, *on_demand_rules)
        ]
    else:
        entries = ()
    on_demand_block = render_on_demand_directory(entries, with_summaries=False)
    return (
        ContextAssembler()
        .add("shared_base", shared_base, SectionOrder.BASE)
        .add("on_demand_directory", on_demand_block, SectionOrder.SKILL_DIRECTORY)
        .add("attachment_context", attachment_context, SectionOrder.ATTACHMENT)
        .render()
    )


def compose_ceo_chat_prompt(
    base_prompt: str,
    *,
    ceo_tool_names: set[str],
    on_demand_entries: Sequence[ConsultDirectoryEntry] = (),
    folder_catalog: Sequence[FolderCatalogEntry] = (),
    cold_start_explore: bool | str | None = False,
    folder_nav_stale: bool = False,
    folder_profile_empty_soft: bool = False,
    # Deprecated: skill_registry / memory_topics / on_demand_rules — prefer on_demand_entries.
    skill_registry: object | None = None,
    memory_topics: Sequence[object] = (),
    on_demand_rules: Sequence[object] = (),
) -> str:
    """Compose the CEO chat agent's system prompt from the clean base.

    Layers the entry coordinator's hint stack onto the shared base: the SLIM CEO core
    + unified ``<按需目录>`` (only when ``consult`` is wired) + derived ``<文件夹清单>`` +
    citation + visualization. ``on_demand_entries`` must match the tool's merged source.
    """
    ceo_core = resolve(FRAGMENT_CEO_CORE, _CEO_CORE_HINT)
    if "update_folder_profile" in ceo_tool_names:
        ceo_core = f"{ceo_core.rstrip()}\n{_FOLDER_PROFILE_TOOL_HINT.strip()}\n"
    if "promote_product" in ceo_tool_names:
        ceo_core = f"{ceo_core.rstrip()}\n{_PROMOTE_PRODUCT_TOOL_HINT.strip()}\n"
    reason: str | None
    if cold_start_explore is True:
        reason = "empty"
    elif cold_start_explore in ("empty", "rebind", "refresh"):
        reason = str(cold_start_explore)
    else:
        reason = None
    explore_block = _explore_act_block(reason)
    empty_soft_block = (
        _FOLDER_PROFILE_EMPTY_SOFT_HINT.strip()
        if folder_profile_empty_soft and not explore_block
        else ""
    )
    stale_block = (
        _FOLDER_NAV_STALE_HINT.strip()
        if folder_nav_stale and not explore_block
        else ""
    )
    if on_demand_entries:
        entries = list(on_demand_entries)
    else:
        entries = [
            ConsultDirectoryEntry(
                name=getattr(t, "name", str(t)),
                summary=getattr(t, "summary", "") or "",
            )
            for t in (*memory_topics, *on_demand_rules)
        ]
        # Test / catalog bridge: skills from registry when no merged entries passed.
        if skill_registry is not None and hasattr(skill_registry, "available"):
            for skill in skill_registry.available(ceo_tool_names):  # type: ignore[union-attr]
                entries.append(
                    ConsultDirectoryEntry(name=skill.name, summary=skill.summary)
                )
    on_demand_block = (
        render_on_demand_directory(entries, with_summaries=True)
        if "consult" in ceo_tool_names and entries
        else ""
    )
    return (
        ContextAssembler()
        .add("ceo_base", base_prompt, SectionOrder.BASE)
        .add("ceo_core", ceo_core, SectionOrder.CEO_CORE)
        .add("cold_start_explore", explore_block, SectionOrder.CEO_CORE)
        .add("folder_profile_empty_soft", empty_soft_block, SectionOrder.CEO_CORE)
        .add("folder_nav_stale", stale_block, SectionOrder.CEO_CORE)
        .add("on_demand_directory", on_demand_block, SectionOrder.SKILL_DIRECTORY)
        .add(
            "folder_catalog",
            render_folder_catalog(folder_catalog),
            SectionOrder.FOLDER_CATALOG,
        )
        .add("citation", resolve(FRAGMENT_CITATION, CHAT_CITATION_HINT), SectionOrder.CITATION)
        .add(
            "ceo_visualization",
            resolve(FRAGMENT_CEO_VISUALIZATION, _CEO_VISUALIZATION_HINT),
            SectionOrder.CEO_VISUALIZATION,
        )
        # D4: 见 assemble_system_prompt —— 本层带来 folder_catalog（项目清单，按最近活跃排序、
        # 却落在稳定前缀中段），正是要能被单独指认的击穿嫌疑段。
        .track_sections(scope="ceo_chat")
        .render()
    )


def derive_ceo_addon(shared_base: str, ceo_full: str) -> str:
    """CEO-specific prompt layers only — everything after the shared base prefix.

    Used by the capability catalog to expose ``ceo_addon`` separately from
    ``shared_base``, so the 能力图鉴 can show the CEO delta without repeating the
    全员 block. Falls back to ``ceo_full`` if the prefix invariant breaks (should
    not happen in production; guarded by integration tests).
    """
    if ceo_full.startswith(shared_base):
        return ceo_full[len(shared_base) :].lstrip("\n")
    return ceo_full
