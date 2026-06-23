"""Turn resolve: prompt assembly, profile variants, CEO toolset wiring."""

from agentcore.runtime.resolve.prepare import _assemble_ceo_toolset, _build_attachment_context
from agentcore.runtime.resolve.profile import (
    FRAGMENT_BASE,
    FRAGMENT_CEO_CORE,
    FRAGMENT_CEO_VISUALIZATION,
    FRAGMENT_CITATION,
    OVERRIDABLE_KEYS,
    PromptProfile,
    active_profile,
    resolve,
    use_profile,
)
from agentcore.runtime.resolve.prompt import (
    CHAT_CITATION_HINT,
    assemble_system_prompt,
    compose_ceo_chat_prompt,
)

__all__ = [
    "CHAT_CITATION_HINT",
    "FRAGMENT_BASE",
    "FRAGMENT_CEO_CORE",
    "FRAGMENT_CEO_VISUALIZATION",
    "FRAGMENT_CITATION",
    "OVERRIDABLE_KEYS",
    "PromptProfile",
    "_assemble_ceo_toolset",
    "_build_attachment_context",
    "active_profile",
    "assemble_system_prompt",
    "compose_ceo_chat_prompt",
    "resolve",
    "use_profile",
]
