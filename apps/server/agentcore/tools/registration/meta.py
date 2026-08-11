"""Registration metadata types and helpers (no tool-class imports)."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal, cast

from agentcore.tools.protocol import Tool, ToolSchema

# Audience tokens — same strings as ``tools.catalog.AVAILABLE_TO_*``.
AUDIENCE_CEO = "ceo"
AUDIENCE_WORKER = "worker"
AUDIENCE_CEO_ONLY: tuple[str, ...] = (AUDIENCE_CEO,)
AUDIENCE_WORKER_ONLY: tuple[str, ...] = (AUDIENCE_WORKER,)
AUDIENCE_BOTH: tuple[str, ...] = (AUDIENCE_CEO, AUDIENCE_WORKER)


class ToolSurface(StrEnum):
    """Where a tool class is collected into a runtime registry / catalog section."""

    BUILTIN = "builtin"
    WORKER_ONLY = "worker_only"
    CEO_ORCHESTRATION = "ceo_orchestration"


class CeoWire(StrEnum):
    """When a CEO-orchestration tool is wired at runtime (catalog always lists it)."""

    ALWAYS = "always"
    MEMORY = "memory"
    # On-demand user rules catalog non-empty → ``consult_rule`` (independent of memory gate).
    RULES = "rules"
    CHECKPOINT = "checkpoint"
    BOARD = "board"
    # Advertised in catalog; runtime inject via ``ceo_surface`` (idle/coord gate).
    COORDINATION = "coordination"


@dataclass(frozen=True)
class ToolRegistration:
    """Class-level registration metadata collected by registries / catalog / wire."""

    surface: ToolSurface
    audience: tuple[str, ...]
    execution_class: bool = False
    local_only: bool = False
    ceo_wire: CeoWire = CeoWire.ALWAYS
    # ``code_execute`` stamps description from backend location.
    needs_location: bool = False
    # L3 team browser (D11 / C1): gated by ``browser_execution_enabled_for`` ON TOP OF
    # ``execution_class`` — server+gVisor, local+Bridge, **or** local 过桥无 Bridge
    # but gVisor/netns healthy (host_kind=sandbox; never open_local_bridge_session).
    browser_class: bool = False
    # Host 第三能力面: gated by ``host≠off`` + desktop backfill channel (desktop_online).
    # Must NOT set ``execution_class`` — L2/L3 never enter kickoff silent grant.
    host_class: bool = False
    # Desktop-online-only tools (≠ Host face): gated solely by ``desktop_online``
    # (e.g. ``external_mount_readonly``). Not gated by ``host≠off``.
    desktop_online_class: bool = False
    # Catalog-gated tools: listed on the roster + capability catalog, but NOT
    # auto-registered by ``build_worker_registry``. Callers wire them after the registry
    # is built when the runtime gate is on (e.g. ``conversation_history_access`` →
    # ``_wire_worker_conversation_log_tools``; product resolve is always on / 定案 A).
    # Same pattern as ``consult_memory``.
    manual_wire: bool = False


def tool_registration(cls: type) -> ToolRegistration:
    reg = getattr(cls, "registration", None)
    if not isinstance(reg, ToolRegistration):
        raise TypeError(f"{cls.__name__} must declare class attribute ``registration``")
    return reg


def read_static_schema(tool_cls: type) -> ToolSchema:
    """Read a pure-static ``schema`` without running heavy ``__init__``."""
    instance: Tool = cast(Tool, object.__new__(tool_cls))
    return instance.schema


def declared_tool_name(cls: type) -> str:
    reg = tool_registration(cls)
    if reg.needs_location:
        return cls(location=None).schema.name  # type: ignore[call-arg]
    if reg.surface is ToolSurface.CEO_ORCHESTRATION:
        return read_static_schema(cls).name
    return cls().schema.name  # type: ignore[call-arg]


def instantiate_declared(
    cls: type,
    *,
    location: Literal["server", "local"] | None = None,
    languages: tuple[str, ...] | list[str] | None = None,
) -> Any:
    """Zero-arg (or location-aware) construction for builtin / worker-only / board /
    ALWAYS tools."""
    reg = tool_registration(cls)
    if reg.needs_location:
        # ``languages`` only applies to ``code_execute`` (probe-trimmed local surface).
        if languages is not None:
            return cls(location=location, languages=languages)  # type: ignore[call-arg]
        return cls(location=location)  # type: ignore[call-arg]
    return cls()  # type: ignore[call-arg]
