"""Capability catalog — the single read-side projection of what this platform's
agents can do (every tool + who may call it), powering ``GET /v1/capabilities`` and
the desktop 能力图鉴.

Single source of truth: tool schemas come from the SAME tool classes the runtime
wires — the worker built-ins via :func:`build_worker_registry`, the CEO-only
orchestration primitives (``delegate`` / ``replan`` / ``revise`` / ``debate`` /
``consult_skill`` / ``consult_memory`` / ``ask_user``)
by reading their static ``schema`` descriptor. So a tool added / renamed / re-described
in the runtime shows up here with NO hand-maintained list to drift — fixing the gap the
old ``GET /tools`` had (it only ever served the worker built-ins, never the CEO's
``delegate`` / ``replan`` / ``revise`` / ``debate`` / ``consult_skill`` /
``consult_memory`` / ``ask_user``, so the user-facing catalog
never matched the CEO's real repertoire).
"""

from __future__ import annotations

from dataclasses import dataclass

from agentcore.tools.builtin import build_ceo_tool_registry, build_worker_registry
from agentcore.tools.builtin.ask_user import AskUserTool
from agentcore.tools.builtin.board_ops import BoardOpsTool
from agentcore.tools.builtin.board_read import BoardReadTool
from agentcore.tools.builtin.consult_memory import ConsultMemoryTool
from agentcore.tools.builtin.consult_skill import ConsultSkillTool
from agentcore.tools.builtin.debate import DebateTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.replan import ReplanTool
from agentcore.tools.builtin.revise import ReviseTool
from agentcore.tools.protocol import ToolSchema

# Who may call a tool. The CEO coordinator holds the read-only built-ins + the
# orchestration primitives; a worker holds the full built-ins (incl. mutation) +
# escalate. A tool reachable by both is shared.
AVAILABLE_TO_CEO = "ceo"
AVAILABLE_TO_WORKER = "worker"


@dataclass(frozen=True)
class CatalogTool:
    """One tool in the capability catalog: its schema + who may call it."""

    schema: ToolSchema
    available_to: tuple[str, ...]


# The CEO-only orchestration tools, wired in ``runtime.pipeline._assemble_ceo_toolset``
# behind heavy runtime deps (llm / sink / session_store / …). Their ``schema`` is a
# pure STATIC descriptor — it reads only module-level constants, never instance state
# (verified across delegate / replan / revise / debate / consult_skill / consult_memory /
# ask_user) — so the catalog reads
# it off an uninitialised instance (:func:`_static_schema`). This keeps the tool class
# the single source of each schema WITHOUT fabricating a turn's worth of runtime objects
# just to read metadata. ``consult_skill`` (always wired), ``consult_memory`` (wired for
# CEO and workers when the memory master switch is on) and ``ask_user`` (wired only on
# the live-user / checkpoint path) are all advertised so the catalog shows the full
# repertoire.
_CEO_ORCHESTRATION_TOOLS: tuple[type, ...] = (
    DelegateTool,
    ReplanTool,
    ReviseTool,
    DebateTool,
    ConsultSkillTool,
    ConsultMemoryTool,
    AskUserTool,
    # board_ops / board_read are wired only in a 白板会话 (run.py, when the conversation is
    # bound to a board), but advertised here so the 能力图鉴 shows the CEO's full repertoire —
    # same posture as ask_user (wired only on the live-user path) above.
    BoardOpsTool,
    BoardReadTool,
)


def _static_schema(tool_cls: type) -> ToolSchema:
    """Read a tool class's static ``schema`` without running its heavy ``__init__``.

    Safe ONLY because these tools' ``schema`` properties are pure static descriptors
    (no ``self`` access). Guarded by ``test_catalog`` which asserts every catalog tool
    exposes a non-empty name/description — so a future schema that needs instance state
    fails loudly instead of silently returning a half-built object.
    """
    instance = object.__new__(tool_cls)
    return instance.schema  # type: ignore[attr-defined]


def build_capability_catalog() -> list[CatalogTool]:
    """Every tool an agent on this platform can call, annotated with CEO/worker reach.

    Order is stable and groupable: the worker built-ins first (CEO-shared read-only and
    worker-only mutation interleaved by registration order), then the CEO-only
    orchestration primitives.
    """
    ceo_builtin_names = set(build_ceo_tool_registry().names)
    catalog: list[CatalogTool] = []
    for schema in build_worker_registry().list_all():
        available = (
            (AVAILABLE_TO_CEO, AVAILABLE_TO_WORKER)
            if schema.name in ceo_builtin_names
            else (AVAILABLE_TO_WORKER,)
        )
        catalog.append(CatalogTool(schema=schema, available_to=available))
    for tool_cls in _CEO_ORCHESTRATION_TOOLS:
        available: tuple[str, ...] = (AVAILABLE_TO_CEO,)
        if tool_cls is ConsultMemoryTool:
            available = (AVAILABLE_TO_CEO, AVAILABLE_TO_WORKER)
        catalog.append(
            CatalogTool(
                schema=_static_schema(tool_cls),
                available_to=available,
            )
        )
    return catalog
