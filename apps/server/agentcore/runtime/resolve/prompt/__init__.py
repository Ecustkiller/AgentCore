"""System prompt assembly for CEO chat and shared worker base.

Composes shared base + optional memory/rules + CEO-only sections
(core routing, citation, visualization hook, skill directory). Skill HOW
bodies live in ``runtime.skills`` and are pulled via ``consult_skill``.

Package layout (fragment seams): ``base`` / ``ceo_core`` / ``citation`` /
``visualization`` / ``memory_rules`` / ``cold_start`` + ``compose`` entry.
Public import path stays ``agentcore.runtime.resolve.prompt``.
"""

from agentcore.runtime.resolve.prompt.base import (
    _DEFAULT_SYSTEM_PROMPT,
    _RUNTIME_CONTEXT_TEMPLATE,
)
from agentcore.runtime.resolve.prompt.ceo_core import (
    _CEO_CORE_HINT,
    _CEO_CORE_HINT_TEMPLATE,
)
from agentcore.runtime.resolve.prompt.citation import CHAT_CITATION_HINT
from agentcore.runtime.resolve.prompt.cold_start import (
    _COLD_START_EXPLORE_HINT_EMPTY,
    _COLD_START_EXPLORE_HINT_REBIND,
    _COLD_START_EXPLORE_HINT_REFRESH,
    _PROJECT_NAV_STALE_HINT,
    _PROJECT_PROFILE_EMPTY_SOFT_HINT,
    _PROJECT_PROFILE_TOOL_HINT,
    _explore_act_block,
)
from agentcore.runtime.resolve.prompt.compose import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
    compose_worker_base_prompt,
    derive_ceo_addon,
    render_memory_topic_directory,
    render_rule_directory,
    render_worker_memory_topic_directory,
    render_worker_rule_directory,
)
from agentcore.runtime.resolve.prompt.memory_rules import (
    _MEMORY_ROUTING_FENCE,
    _MEMORY_RULES_TEMPLATE,
    _MEMORY_SUBSECTION_TEMPLATE,
    _RULES_WITH_USER_TEMPLATE,
    _format_memory_rules,
    _format_rules,
    _format_rules_with_user,
)
from agentcore.runtime.resolve.prompt.visualization import _CEO_VISUALIZATION_HINT

__all__ = [
    "CHAT_CITATION_HINT",
    "_CEO_CORE_HINT",
    "_CEO_CORE_HINT_TEMPLATE",
    "_CEO_VISUALIZATION_HINT",
    "_COLD_START_EXPLORE_HINT_EMPTY",
    "_COLD_START_EXPLORE_HINT_REBIND",
    "_COLD_START_EXPLORE_HINT_REFRESH",
    "_DEFAULT_SYSTEM_PROMPT",
    "_MEMORY_ROUTING_FENCE",
    "_MEMORY_RULES_TEMPLATE",
    "_MEMORY_SUBSECTION_TEMPLATE",
    "_PROJECT_NAV_STALE_HINT",
    "_PROJECT_PROFILE_EMPTY_SOFT_HINT",
    "_PROJECT_PROFILE_TOOL_HINT",
    "_RULES_WITH_USER_TEMPLATE",
    "_RUNTIME_CONTEXT_TEMPLATE",
    "_explore_act_block",
    "_format_memory_rules",
    "_format_rules",
    "_format_rules_with_user",
    "assemble_system_prompt",
    "compose_ceo_chat_prompt",
    "compose_worker_base_prompt",
    "derive_ceo_addon",
    "render_memory_topic_directory",
    "render_rule_directory",
    "render_worker_memory_topic_directory",
    "render_worker_rule_directory",
]
