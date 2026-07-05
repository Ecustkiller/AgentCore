"""Capability catalog (read-only): the complete 能力图鉴 the desktop renders.

One aggregate endpoint over the platform's agent capabilities — every tool (CEO +
worker, annotated with who may call it), the system Skills (catalog summary + full
body), and the system-prompt template the CEO follows. Every field is derived from the
SAME sources the runtime wires (``tools.catalog`` / ``runtime.skills`` /
``runtime.prompt.compose_ceo_chat_prompt``), so what the user sees never drifts from what
the agents are actually given. Auth matches the app's authenticated posture; the catalog
is static platform metadata (not user-scoped).
"""

from fastapi import APIRouter

from agentcore.api.dependencies import AuthUser
from agentcore.api.schemas import (
    CapabilitiesResponse,
    CapabilityGuidelines,
    CapabilitySkill,
    CapabilityTool,
)
from agentcore.config import settings
from agentcore.runtime.prompt import (
    assemble_system_prompt,
    compose_ceo_chat_prompt,
    derive_ceo_addon,
)
from agentcore.runtime.skills import build_system_skill_registry
from agentcore.tools.catalog import AVAILABLE_TO_CEO, build_capability_catalog

router = APIRouter(prefix="/capabilities", tags=["capabilities"])


@router.get("", response_model=CapabilitiesResponse)
async def get_capabilities(_user: AuthUser) -> CapabilitiesResponse:
    """The complete capability picture: tools (with CEO/worker reach), system Skills,
    and the CEO system-prompt template — the data behind 工具箱 → 能力图鉴."""
    catalog = build_capability_catalog()
    tools = [
        CapabilityTool(
            name=entry.schema.name,
            description=entry.schema.description,
            category=entry.schema.category,
            approval=entry.schema.approval,
            parameters=entry.schema.parameters,
            available_to=list(entry.available_to),
        )
        for entry in catalog
    ]

    # Honor legal_vertical_enabled so the catalog matches the CEO's runtime repertoire
    # (the pipeline wires the same include_legal) — else the 能力图鉴 silently drifts.
    skill_registry = build_system_skill_registry(include_legal=settings.legal_vertical_enabled)
    skills = [
        CapabilitySkill(name=skill.name, summary=skill.summary, body=skill.body)
        for skill in skill_registry.list_all()
    ]

    # The CEO prompt template: composed with the catalog's CEO tool names so the 能力目录
    # reflects the full repertoire (e.g. ask_user_kickoff shows because ask_user is a CEO
    # tool). No per-user memory / per-turn attachments — this is the static blueprint.
    ceo_tool_names = {
        entry.schema.name for entry in catalog if AVAILABLE_TO_CEO in entry.available_to
    }
    shared_base = assemble_system_prompt()
    ceo = compose_ceo_chat_prompt(
        shared_base,
        skill_registry=skill_registry,
        ceo_tool_names=ceo_tool_names,
    )
    guidelines = CapabilityGuidelines(
        shared_base=shared_base,
        ceo_addon=derive_ceo_addon(shared_base, ceo),
        ceo=ceo,
    )

    return CapabilitiesResponse(tools=tools, skills=skills, guidelines=guidelines)
