"""Built-in tool implementations."""

from typing import Literal

from agentcore.config import settings
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin.amend_note import AmendNoteTool
from agentcore.tools.builtin.code_execute import CodeExecuteTool
from agentcore.tools.builtin.code_search import CodeSearchTool
from agentcore.tools.builtin.desktop_notify import DesktopNotifyTool
from agentcore.tools.builtin.escalate import EscalateTool
from agentcore.tools.builtin.file_ops import (
    FileAppendTool,
    FileDeleteTool,
    FileListTool,
    FileMoveTool,
    FileReadTool,
    FileWriteTool,
    StrReplaceTool,
)
from agentcore.tools.builtin.git_ops import GitTool
from agentcore.tools.builtin.grep import GrepTool
from agentcore.tools.builtin.handoff import HandoffTool
from agentcore.tools.builtin.post_note import PostNoteTool
from agentcore.tools.builtin.read_notes import ReadNotesTool
from agentcore.tools.builtin.terminal import TerminalTool
from agentcore.tools.builtin.test_run import TestRunTool
from agentcore.tools.builtin.web.read_url import ReadUrlTool
from agentcore.tools.builtin.web.search import WebSearchTool
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.protocol import WorkspaceBackend


def code_execution_enabled_for(backend: WorkspaceBackend | None) -> bool:
    """Whether the code-execution tool class may appear in a runtime worker toolset.

    Governs the WHOLE class that runs code through the sandbox chain — ``code_execute``
    AND ``test_run`` (a test suite executes arbitrary project code, so it is
    execution-equivalent). Local / sidecar execution stays on; cloud ``location=server``
    defaults off unless ``GVISOR_ENABLED`` or ``CODE_EXECUTE_CLOUD_ENABLED`` is set (a
    plain subprocess in the API container is not a real isolation boundary — 安全权限与
    治理 §5). Keeping both tools behind ONE predicate (not a per-tool special-case) is
    what makes the production-security posture cover the class consistently.
    """
    if backend is None:
        return True
    if backend.location == "local":
        return True
    return settings.gvisor_enabled or settings.code_execute_cloud_enabled


def build_builtin_registry(
    *,
    include_execution_tools: bool = True,
    location: Literal["server", "local"] | None = None,
) -> ToolRegistry:
    """Register the platform's built-in tools (single source of truth).

    Both the chat pipeline (worker toolset) and the read-only ``GET /tools``
    catalog build from this. The CEO-only ``delegate`` orchestration primitive is
    intentionally excluded — it is wired separately in ``runtime.pipeline`` and is
    not a general-purpose capability a worker (or the catalog) should advertise.

    ``include_execution_tools`` gates the code-execution class as a unit
    (``test_run`` + ``code_execute``): the worker registry withholds BOTH on a backend
    that can't run code safely (see ``code_execution_enabled_for``), so a new
    execution-class tool is governed the same way without another call-site edit. The
    default (True) keeps them present for the class-defining derivations
    (``per_call_tool_names`` / ``build_ceo_tool_registry``) and the ``GET /tools`` catalog.

    ``location`` stamps ``code_execute``'s description to match the turn's backend
    (server sandbox vs user machine). ``None`` (catalog) keeps a binding-agnostic
    wording — never the old two-way「可能跑在用户机器上」hedge.
    """
    registry = ToolRegistry()
    registry.register(WebSearchTool())
    registry.register(ReadUrlTool())
    registry.register(FileReadTool())
    registry.register(FileWriteTool())
    registry.register(FileAppendTool())
    registry.register(StrReplaceTool())
    registry.register(FileListTool())
    registry.register(FileDeleteTool())
    registry.register(FileMoveTool())
    registry.register(GrepTool())
    registry.register(CodeSearchTool())
    registry.register(GitTool())
    if include_execution_tools:
        registry.register(TestRunTool())
        registry.register(CodeExecuteTool(location=location))
    return registry


def build_worker_registry(
    *,
    backend: WorkspaceBackend | None = None,
    permission_preset: "PermissionPreset | None" = None,
) -> ToolRegistry:
    """The delegated worker's toolset: the platform built-ins PLUS the worker-only
    ``escalate`` upward channel.

    Kept separate from ``build_builtin_registry`` so ``escalate`` reaches workers
    WITHOUT leaking into the CEO's own toolset (``build_ceo_tool_registry`` derives the
    CEO subset from the builtins) or the read-only ``GET /tools`` capability catalog —
    mirroring how ``delegate`` / ``ask_user`` are wired in only where they belong. A
    worker that re-delegates passes this registry on, so its sub-workers inherit
    ``escalate`` too (a sub-worker escalates to its captain worker, which can re-escalate
    to the CEO).

    ``permission_preset=observe`` withholds the entire execution class
    (``code_execute`` / ``test_run`` / ``terminal``) — read-only retrieval stays on.
    """
    from agentcore.core.types import PermissionPreset

    location = backend.location if backend is not None else None
    include_execution = code_execution_enabled_for(backend)
    if permission_preset is PermissionPreset.OBSERVE:
        include_execution = False
    registry = build_builtin_registry(
        include_execution_tools=include_execution,
        location=location,
    )
    registry.register(EscalateTool())
    # post_note (the 便签墙 broadcast channel, §2.2 通) rides the same worker-only path as
    # escalate: kept out of the CEO / catalog toolsets, offered to every worker so any
    # sibling can broadcast a decision / heads-up to its concurrent peers.
    registry.register(PostNoteTool())
    # read_notes (the 便签墙 on-demand READ, §2.4 变·worker 的「拉」) is post_note's pull dual:
    # same worker-only path, so a worker can actively look up what a sibling already decided.
    registry.register(ReadNotesTool())
    # amend_note (改写 / 作废, §2.2 supersession) completes the trio: same worker-only path, so a
    # worker can correct its OWN stale note before a sibling builds on a dead decision.
    registry.register(AmendNoteTool())
    # handoff (完工交接简报 + 收尾, terminal) rides the same worker-only path: a worker submits
    # its STRUCTURED brief (结论 / 关键要点 / 关键假设 / 建议下一步) and finishes, so the brief is
    # read off the call args (never parsed out of prose) so the deliverable「输出」never
    # doubles it.
    registry.register(HandoffTool())
    registry.register(DesktopNotifyTool())
    # terminal (后台进程): local-only — processes are held by the desktop main process
    # over workspace_op_required. Kept out of build_builtin_registry so NEVER does not
    # leak into the CEO read-only filter (工具与能力系统 terminal 行). Withheld under
    # observe together with the rest of the execution class.
    if include_execution and backend is not None and backend.location == "local":
        registry.register(TerminalTool())
    return registry


def build_ceo_tool_registry() -> ToolRegistry:
    """The CEO chat agent's DIRECT toolset: read / retrieval only (协调者 CEO).

    The CEO is a coordinator — it *looks* (web_search, read_url, file_read,
    file_list, grep, code_search) and answers simple requests directly, but it holds NONE of
    the production / mutation tools (file_write, file_append, str_replace, file_delete,
    file_move, code_execute). Any work that produces or changes an artifact is
    handed to a worker via ``delegate``; workers carry the FULL toolset
    (``build_builtin_registry``).

    The split is by approval level: a ``GRANTABLE`` tool mutates the environment
    (and is exactly the work that belongs to the team), while a ``NEVER`` tool is
    safe to read with. Deriving the CEO subset from the single builtin registry
    keeps one source of truth — a new read-only tool reaches the CEO
    automatically; a new mutating tool stays worker-only.

    → 见设计: docs/03-AI核心/编排器与CEO主Agent.md §核心定位（协调者 CEO 工具边界）
    """
    full = build_builtin_registry()
    registry = ToolRegistry()
    for schema in full.list_all():
        if schema.approval is ToolApproval.NEVER:
            registry.register(full.get(schema.name))
    return registry


def approval_class_tool_names() -> frozenset[str]:
    """Tools covered by an ``APPROVE_ALWAYS_FILES`` turn grant.

    The file-mutation class plus ``git`` write (``git`` schema stays ``NEVER`` so
    CEO read-only subcommands stay in the filtered registry).
    """
    return file_mutation_tool_names() | frozenset({"git"})


def file_mutation_tool_names() -> frozenset[str]:
    """The GRANTABLE file-mutation tools as one class (file_write / str_replace /
    file_delete / file_move) — what a「本轮内允许所有文件改动」grant covers.

    Derived from the single builtin registry as ``GRANTABLE ∩ FILESYSTEM`` so a new
    file-edit tool joins the class automatically, while ``code_execute`` (EXECUTION,
    a higher-risk side effect) stays out and keeps its own per-tool gate — the
    same single-source posture as ``build_ceo_tool_registry`` (安全权限与治理 §三
    边界2: 信任「这类操作」而非「随便干」).
    """
    full = build_builtin_registry()
    return frozenset(
        schema.name
        for schema in full.list_all()
        if schema.approval is ToolApproval.GRANTABLE and schema.category is ToolCategory.FILESYSTEM
    )


def delegation_grantable_tool_names() -> frozenset[str]:
    """Tools covered by a kickoff / per-delegation grant (统一授权白名单).

    Same medium-risk set the turn-level grants can cover: file-mutation class
    (``file_write`` / ``file_append`` / ``str_replace`` / ``file_delete`` /
    ``file_move``) + ``git`` writes + execution class (``code_execute`` /
    ``test_run`` / ``terminal`` start). After the user chooses grant-and-start on the
    kickoff card, these tools skip per-call approval for the rest of THAT delegation
    (keyed by ``execution_id``). Keep this set aligned with turn-level scopes so
    a kickoff grant and a「本轮内都允许」do not disagree on what is covered.
    """
    return approval_class_tool_names() | frozenset({"code_execute", "test_run", "terminal"})


def per_call_tool_names() -> frozenset[str]:
    """Tools whose「本轮内都允许」is refused and downgraded to a one-shot approve.

    Empty by design (Cursor-aligned UX, 2026-07): execution-class tools
    (``code_execute`` / ``test_run``) may take a turn-wide ``APPROVE_ALWAYS`` grant
    like other GRANTABLE tools. PI-004「注入搭便车」is accepted as the same tradeoff
    Cursor makes for a local trusted user; the main-process native gate still requires
    a first click (optional session allow). ``ApprovalGate`` keeps the downgrade path
    for a non-empty set (defense in depth / future re-tightening).
    """
    return frozenset()
