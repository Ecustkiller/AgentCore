"""Built-in tool implementations."""

from agentcore.config import settings
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin.amend_note import AmendNoteTool
from agentcore.tools.builtin.code_execute import CodeExecuteTool
from agentcore.tools.builtin.code_search import CodeSearchTool
from agentcore.tools.builtin.escalate import EscalateTool
from agentcore.tools.builtin.file_ops import (
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
from agentcore.tools.builtin.test_run import TestRunTool
from agentcore.tools.builtin.web.read_url import ReadUrlTool
from agentcore.tools.builtin.web.search import WebSearchTool
from agentcore.tools.registry import ToolRegistry
from agentcore.workspace.protocol import WorkspaceBackend


def code_execute_enabled_for(backend: WorkspaceBackend | None) -> bool:
    """Whether ``code_execute`` may appear in a runtime worker toolset.

    Local / sidecar execution stays on; cloud ``location=server`` defaults off unless
    ``GVISOR_ENABLED`` or ``CODE_EXECUTE_CLOUD_ENABLED`` is set (plain subprocess in
    the API container is not a real isolation boundary — 安全权限与治理 §5).
    """
    if backend is None:
        return True
    if backend.location == "local":
        return True
    return settings.gvisor_enabled or settings.code_execute_cloud_enabled


def build_builtin_registry(*, include_code_execute: bool = True) -> ToolRegistry:
    """Register the platform's built-in tools (single source of truth).

    Both the chat pipeline (worker toolset) and the read-only ``GET /tools``
    catalog build from this. The CEO-only ``delegate`` orchestration primitive is
    intentionally excluded — it is wired separately in ``runtime.pipeline`` and is
    not a general-purpose capability a worker (or the catalog) should advertise.
    """
    registry = ToolRegistry()
    registry.register(WebSearchTool())
    registry.register(ReadUrlTool())
    registry.register(FileReadTool())
    registry.register(FileWriteTool())
    registry.register(StrReplaceTool())
    registry.register(FileListTool())
    registry.register(FileDeleteTool())
    registry.register(FileMoveTool())
    registry.register(GrepTool())
    registry.register(CodeSearchTool())
    registry.register(GitTool())
    registry.register(TestRunTool())
    if include_code_execute:
        registry.register(CodeExecuteTool())
    return registry


def build_worker_registry(*, backend: WorkspaceBackend | None = None) -> ToolRegistry:
    """The delegated worker's toolset: the platform built-ins PLUS the worker-only
    ``escalate`` upward channel.

    Kept separate from ``build_builtin_registry`` so ``escalate`` reaches workers
    WITHOUT leaking into the CEO's own toolset (``build_ceo_tool_registry`` derives the
    CEO subset from the builtins) or the read-only ``GET /tools`` capability catalog —
    mirroring how ``delegate`` / ``ask_user`` are wired in only where they belong. A
    worker that re-delegates passes this registry on, so its sub-workers inherit
    ``escalate`` too (a sub-worker escalates to its captain worker, which can re-escalate
    to the CEO).
    """
    registry = build_builtin_registry(
        include_code_execute=code_execute_enabled_for(backend),
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
    return registry


def build_ceo_tool_registry() -> ToolRegistry:
    """The CEO chat agent's DIRECT toolset: read / retrieval only (协调者 CEO).

    The CEO is a coordinator — it *looks* (web_search, read_url, file_read,
    file_list, grep, code_search) and answers simple requests directly, but it holds NONE of
    the production / mutation tools (file_write, str_replace, file_delete,
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


def per_call_tool_names() -> frozenset[str]:
    """The GRANTABLE tools that must be confirmed PER CALL — never whitelisted for the
    rest of the turn by a「本轮内都允许」(APPROVE_ALWAYS) grant (today: ``code_execute``).

    Derived from the single builtin registry as ``GRANTABLE ∩ EXECUTION`` (the same
    single-source posture as ``file_mutation_tool_names``): ``code_execute`` is the
    highest-risk side effect, so a turn-wide grant on it is refused and each call is
    confirmed individually — closing the「授权一次 → 本回合后续被注入内容驱动的执行免再问」
    缺口 (PI-004 / 安全权限与治理 §三 边界2). ``ApprovalGate`` consumes this.
    """
    full = build_builtin_registry()
    return frozenset(
        schema.name
        for schema in full.list_all()
        if schema.approval is ToolApproval.GRANTABLE and schema.category is ToolCategory.EXECUTION
    )
