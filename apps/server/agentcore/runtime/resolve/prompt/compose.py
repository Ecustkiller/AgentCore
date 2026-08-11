"""Compose / assemble system prompts from prompt fragments."""

import time
from collections.abc import Sequence

from agentcore.memory.injection import MemoryTopic
from agentcore.memory.rules_injection import OnDemandUserRule
from agentcore.runtime.context import ContextAssembler, SectionOrder
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
from agentcore.runtime.resolve.prompt.ceo_core import _CEO_CORE_HINT
from agentcore.runtime.resolve.prompt.citation import CHAT_CITATION_HINT
from agentcore.runtime.resolve.prompt.cold_start import (
    _PROJECT_NAV_STALE_HINT,
    _PROJECT_PROFILE_EMPTY_SOFT_HINT,
    _PROJECT_PROFILE_TOOL_HINT,
    _explore_act_block,
)
from agentcore.runtime.resolve.prompt.memory_rules import _format_rules
from agentcore.runtime.resolve.prompt.visualization import _CEO_VISUALIZATION_HINT
from agentcore.runtime.skills import SkillRegistry, render_skill_directory


def assemble_system_prompt(
    *,
    memory_markdown: str | None = None,
    user_rules_markdown: str | None = None,
    extra_context: str | None = None,
    workspace_context: str | None = None,
) -> str:
    """Build the system prompt for a conversation.

    `memory_markdown` is the user's AI-maintained long-term memory (see memory/store.py);
    `user_rules_markdown` is the user's OWN rules (``ai_maintained=false``). When either is
    present they are injected as ONE ``<rules>`` block — user rules first with authoritative
    wording, memory after with soft wording (Agent记忆与知识系统 §二 两档措辞). With no user
    rules the block is byte-identical to the prior memory-only assembly. This base prompt is
    shared by the CEO chat agent and the delegated workers (runs/executor/), so both reach
    every agent.

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
            _format_rules(memory_markdown, user_rules_markdown),
            SectionOrder.MEMORY,
        )
        .add("attachment_context", extra_context, SectionOrder.ATTACHMENT)
        .render()
    )


def render_worker_memory_topic_directory(topics: Sequence[MemoryTopic]) -> str:
    """Render the worker's simplified ``<记忆主题目录>`` block (names only).

    Workers share the same on-demand TOPIC notes as the CEO but get a lighter catalog —
    topic names without one-line summaries — to keep the delegated prefix smaller. Returns
    "" when the user has no topic notes (caller gates on ``memory_enabled`` separately).
    """
    if not topics:
        return ""
    lines = [
        "<记忆主题目录>",
        "下列记忆主题可按需查阅（`consult_memory(name)` 拉取全文；核心记忆已常驻、无需查阅）：",
    ]
    lines.extend(f"- {t.name}" for t in topics)
    lines.append("</记忆主题目录>")
    return "\n".join(lines)


def render_worker_rule_directory(rules: Sequence[OnDemandUserRule]) -> str:
    """Worker simplified ``<规则目录>`` (names only; mirrors memory topic worker catalog)."""
    if not rules:
        return ""
    lines = [
        "<规则目录>",
        "下列按需用户规则可查阅（`consult_rule(name)` 拉取全文；always 规则已常驻 ``<rules>``）：",
    ]
    lines.extend(f"- {r.name}" for r in rules)
    lines.append("</规则目录>")
    return "\n".join(lines)


def compose_worker_base_prompt(
    shared_base: str,
    *,
    memory_topics: Sequence[MemoryTopic] = (),
    memory_enabled: bool = True,
    on_demand_rules: Sequence[OnDemandUserRule] = (),
    attachment_context: str | None = None,
) -> str:
    """Build the delegated worker's system prompt from the shared base.

    Layers the worker-only simplified 记忆主题目录 / 规则目录 when catalogs are non-empty,
    then the per-turn attachment block last (缓存友好). ``shared_base`` is the output of
    ``assemble_system_prompt`` — identity, runtime context, core memory.
    """
    memory_block = (
        render_worker_memory_topic_directory(memory_topics) if memory_enabled else ""
    )
    # Directory↔tool: worker prompt only lists rules when the turn will wire consult_rule
    # (caller passes the same non-empty catalog used for the wire gate).
    rules_block = render_worker_rule_directory(on_demand_rules)
    return (
        ContextAssembler()
        .add("shared_base", shared_base, SectionOrder.BASE)
        .add("memory_topics", memory_block, SectionOrder.MEMORY_TOPICS)
        .add("rule_directory", rules_block, SectionOrder.RULE_DIRECTORY)
        .add("attachment_context", attachment_context, SectionOrder.ATTACHMENT)
        .render()
    )


def render_memory_topic_directory(topics: Sequence[MemoryTopic]) -> str:
    """Render the CEO-only ``<记忆主题目录>`` block listing the consultable topic notes.

    The user's memory is a folder (记忆文件夹化 §六): a small always-injected CORE note
    (画像) plus on-demand TOPIC notes (主题/<slug>.md). Each topic rides the prompt as its
    NAME plus a one-line summary (its first substantive line, 记忆系统 §1.4) — enough for the
    model to decide WHEN to pull a note's full body via ``consult_memory(name)`` — so deep,
    occasional knowledge stays out of the常驻 prefix. A topic with no summary (empty /
    chrome-only note) shows just its name. Returns "" when the user has no topic notes so the
    caller appends nothing (and the directory↔tool invariant: the caller renders this only
    when ``consult_memory`` is wired this turn).
    """
    if not topics:
        return ""
    lines = [
        "<记忆主题目录>",
        "下列是该用户的「记忆主题笔记」（仅列主题名＋一行摘要、全文未常驻）；当某主题与当前任务"
        "相关时，先用 `consult_memory(name)` 把该主题全文拉回来再据此执行（用户画像等核心记忆"
        "已常驻、无需查阅）：",
    ]
    lines.extend(f"- {t.name}：{t.summary}" if t.summary else f"- {t.name}" for t in topics)
    lines.append("</记忆主题目录>")
    return "\n".join(lines)


def render_rule_directory(rules: Sequence[OnDemandUserRule]) -> str:
    """Render the CEO ``<规则目录>`` for on_demand user rules (consult_rule).

    Constraint appendices — not memory topics. Returns "" when empty so the caller
    appends nothing (directory↔tool: only when ``consult_rule`` is wired this turn).
    """
    if not rules:
        return ""
    lines = [
        "<规则目录>",
        "下列是该用户的「按需用户规则」（仅列规则名＋一行摘要、全文未常驻）；当某条与当前任务"
        "相关时，先用 `consult_rule(name)` 把该规则全文拉回来再据此遵守（always 用户规则已在"
        "``<rules>`` 常驻、无需查阅；记忆主题请用 `consult_memory`，勿与本目录混淆）：",
    ]
    lines.extend(f"- {r.name}：{r.summary}" if r.summary else f"- {r.name}" for r in rules)
    lines.append("</规则目录>")
    return "\n".join(lines)


def compose_ceo_chat_prompt(
    base_prompt: str,
    *,
    skill_registry: SkillRegistry,
    ceo_tool_names: set[str],
    memory_topics: Sequence[MemoryTopic] = (),
    on_demand_rules: Sequence[OnDemandUserRule] = (),
    cold_start_explore: bool | str | None = False,
    project_nav_stale: bool = False,
    project_profile_empty_soft: bool = False,
) -> str:
    """Compose the CEO chat agent's system prompt from the clean base.

    Layers the entry coordinator's hint stack onto the shared base: the SLIM CEO core
    routing hint + the always-on 能力目录 (only the skills whose required tools are in
    ``ceo_tool_names`` — the same live-tool gate the runtime applies, e.g. the
    ``ask_user_*`` skills show only when ``ask_user`` is wired) + the CEO-only 记忆主题目录
    (``memory_topics``, listing the user's on-demand TOPIC notes as name＋一行摘要 — rendered
    only when ``consult_memory`` is wired this turn, the same live-tool gate as the skill
    directory)
    + inline citation guidance + the CEO-only ``<visualization>`` block (按角色 right-size:
    the detailed charting HOW rides only the user-facing voice, not every worker — workers
    keep the base's one-line affordance). The per-turn attachment block is appended by the
    caller AFTER this so the stable hint stack stays prefix-cache friendly (缓存友好).

    ``cold_start_explore``: ``False``/``None``/``\"\"`` off; ``True`` or ``\"empty\"`` empty-profile
    hard gate (工程点名); ``\"rebind\"`` workspace-identity mismatch gate (过期再探);
    ``\"refresh\"`` named-refresh hard gate (点名硬闸).
    ``project_profile_empty_soft``: empty profile soft hint (never blocking; separate from
    ``<cold_start_explore>``).
    ``project_nav_stale``: R2 soft hint when fingerprint drifted (never blocking; separate
    from ``<cold_start_explore>``).

    Single source shared by the live turn (``runtime.pipeline``) and the static
    capability catalog (``api`` 能力图鉴), so what the user sees as「AI 工作准则」never
    drifts from what the CEO is actually given. Byte-identical to the prior inline
    pipeline assembly (the empty-skill-directory case is dropped by ``add``).
    """
    ceo_core = resolve(FRAGMENT_CEO_CORE, _CEO_CORE_HINT)
    if "update_project_profile" in ceo_tool_names:
        ceo_core = f"{ceo_core.rstrip()}\n{_PROJECT_PROFILE_TOOL_HINT.strip()}\n"
    reason: str | None
    if cold_start_explore is True:
        reason = "empty"
    elif cold_start_explore in ("empty", "rebind", "refresh"):
        reason = str(cold_start_explore)
    else:
        reason = None
    explore_block = _explore_act_block(reason)
    empty_soft_block = (
        _PROJECT_PROFILE_EMPTY_SOFT_HINT.strip()
        if project_profile_empty_soft and not explore_block
        else ""
    )
    stale_block = (
        _PROJECT_NAV_STALE_HINT.strip()
        if project_nav_stale and not explore_block
        else ""
    )
    return (
        ContextAssembler()
        .add("ceo_base", base_prompt, SectionOrder.BASE)
        .add("ceo_core", ceo_core, SectionOrder.CEO_CORE)
        .add("cold_start_explore", explore_block, SectionOrder.CEO_CORE)
        .add("project_profile_empty_soft", empty_soft_block, SectionOrder.CEO_CORE)
        .add("project_nav_stale", stale_block, SectionOrder.CEO_CORE)
        .add(
            "skill_directory",
            render_skill_directory(skill_registry, ceo_tool_names),
            SectionOrder.SKILL_DIRECTORY,
        )
        .add(
            "memory_topics",
            # Directory↔tool invariant: advertise the consultable topics only when the
            # consult_memory tool is actually wired this turn (memory master switch on),
            # mirroring the skill directory's live-tool gate. An empty block is dropped
            # by ``add``.
            render_memory_topic_directory(memory_topics)
            if "consult_memory" in ceo_tool_names
            else "",
            SectionOrder.MEMORY_TOPICS,
        )
        .add(
            "rule_directory",
            render_rule_directory(on_demand_rules)
            if "consult_rule" in ceo_tool_names
            else "",
            SectionOrder.RULE_DIRECTORY,
        )
        .add("citation", resolve(FRAGMENT_CITATION, CHAT_CITATION_HINT), SectionOrder.CITATION)
        .add(
            "ceo_visualization",
            resolve(FRAGMENT_CEO_VISUALIZATION, _CEO_VISUALIZATION_HINT),
            SectionOrder.CEO_VISUALIZATION,
        )
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
