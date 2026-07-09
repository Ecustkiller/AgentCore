"""Tool catalog + capability picture (能力图鉴) schemas."""

from typing import Any

from pydantic import BaseModel

from agentcore.core.types import ToolApproval, ToolCategory


class CapabilityTool(BaseModel):
    """A tool in the capability catalog: its public schema + who may call it.

    The COMPLETE catalog — CEO orchestration primitives (``delegate`` / ``revise`` /
    ``consult_skill`` / ``ask_user``) and the worker-only ``escalate``.
    ``available_to`` is a subset of ``["ceo", "worker"]`` so the UI can show which
    side of the team holds each tool.
    """

    name: str
    description: str
    category: ToolCategory
    approval: ToolApproval
    parameters: dict[str, Any]
    available_to: list[str]


class CapabilitySkill(BaseModel):
    """A system Skill in the catalog (渐进披露): its catalog ``summary`` (the always-on
    one-line trigger) plus the full ``body`` guidance the CEO pulls via consult_skill."""

    name: str
    summary: str
    body: str


class CapabilityGuidelines(BaseModel):
    """The system-prompt TEMPLATE the agents follow (静态 蓝图; the per-turn verbatim
    prompt is served separately, see the message prompt endpoint).

    ``shared_base`` is the base every agent (CEO + workers) shares (identity, output
    style, tool-use, safety); ``ceo_addon`` is the CEO coordinator's layers on top of
    that base (routing core + 能力目录 + citation guidance); ``ceo`` is the full chat
    system-prompt template (shared base + ceo_addon), composed by the SAME
    ``compose_ceo_chat_prompt`` the live turn uses, so it never drifts.
    """

    shared_base: str
    ceo_addon: str
    ceo: str


class CapabilitiesResponse(BaseModel):
    """The complete capability picture for the 能力图鉴 page (single fetch)."""

    tools: list[CapabilityTool]
    skills: list[CapabilitySkill]
    guidelines: CapabilityGuidelines
