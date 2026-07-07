"""In-process tool-approval coordination (MVP, single-worker).

A GRANTABLE tool call is suspended until the user authorizes it: the running
engine task ``await``s a Future, and a separate HTTP request (the resolve
endpoint) sets that Future. State is in-process — the same single-worker posture
the rate limiter already takes (see ``config.py``); front with Redis to scale to
multiple workers.

Scope: the CEO chat path always. Delegated workers share this SAME per-turn gate
ONLY in local mode (双模式工作区 P2d 执行门) — a worker must not run code or
mutate files on the user's real machine without the same consent the CEO gives.
In cloud mode workers stay un-gated (the server sandbox is isolated) and are
handed no gate.
"""

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval
from agentcore.runtime.events import EventSink, approval_required, approval_resolved
from agentcore.runtime.interaction import InteractionKind
from agentcore.runtime.ports import ClientRequestBridge

logger = get_logger(__name__)

# Argument values longer than this are truncated in the SSE preview so a big
# file_write body does not bloat the approval event.
_PREVIEW_VALUE_MAX = 600
# code_execute's ``code`` is the review surface — users must see enough to approve.
_PREVIEW_CODE_EXECUTE_CODE_MAX = 20_000
_TRUNCATION_SUFFIX = "… [truncated]"


def tool_call_requires_approval(
    tool_name: str, approval: ToolApproval, arguments: dict[str, Any]
) -> bool:
    """Whether a tool call must pass ``ApprovalGate`` before execution.

    GRANTABLE tools always do. ``git`` is ``NEVER`` at schema level (so the CEO
    registry filter keeps read subcommands) but write subcommands are gated here
    on workers — same posture as ``file_write``.
    """
    if approval is ToolApproval.GRANTABLE:
        return True
    if tool_name == "git":
        from agentcore.tools.builtin.git_ops import git_write_subcommands

        subcommand = str(arguments.get("subcommand", "")).strip().lower()
        return subcommand in git_write_subcommands()
    return False


class ApprovalDecision(StrEnum):
    """How the user (or a timeout) settled a tool-approval request."""

    APPROVE = "approve"  # allow this one call
    APPROVE_ALWAYS = "approve_always"  # allow this tool for the rest of the turn
    # allow the whole file-mutation class (file_write / str_replace / file_delete /
    # file_move) for the rest of the turn — one click for a multi-file or mixed-op
    # task instead of granting each tool name separately. code_execute is NOT in the
    # class (a higher-risk side effect) and keeps its own per-tool gate (安全权限与
    # 治理 §三 边界2: 信任"这类操作", 不是"随便干").
    APPROVE_ALWAYS_FILES = "approve_always_files"
    DENY = "deny"  # refuse; the model is told and may adapt


def _preview_value_max(tool_name: str, key: str) -> int:
    if tool_name == "code_execute" and key == "code":
        return _PREVIEW_CODE_EXECUTE_CODE_MAX
    return _PREVIEW_VALUE_MAX


def _preview_arguments(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Bound large string values so the approval SSE event stays small."""
    preview: dict[str, Any] = {}
    for key, value in arguments.items():
        if isinstance(value, str):
            limit = _preview_value_max(tool_name, key)
            if len(value) > limit:
                preview[key] = value[:limit] + _TRUNCATION_SUFFIX
            else:
                preview[key] = value
        else:
            preview[key] = value
    return preview


@dataclass
class ApprovalGate:
    """Per-turn gate suspending GRANTABLE tool calls until the user decides.

    One instance per chat turn. ``_granted`` remembers tools the user chose to
    allow for the rest of the turn, so a LATER call to the same tool does not
    re-prompt. A grant also sweeps the matching calls ALREADY suspended on this gate
    (parallel workers share one gate in local mode), so a single "allow" clears
    every matching pending prompt at once — not just the one the user clicked.

    Two grant scopes: ``APPROVE_ALWAYS`` whitelists the ONE tool of the card;
    ``APPROVE_ALWAYS_FILES`` whitelists the whole file-mutation class
    (``file_op_tools``) so a multi-file / mixed-op task is unblocked with one click.
    ``code_execute`` (and any other ``per_call_tools``) is exempt from BOTH: a turn-wide
    grant is refused for it, so it is confirmed per call and a later injected-content-
    driven execution cannot ride an earlier "allow for the turn" (PI-004).
    """

    sink: EventSink
    conversation_id: str
    registry: ClientRequestBridge
    timeout_seconds: float
    # The file-mutation tool class an APPROVE_ALWAYS_FILES grant covers
    # (file_write / str_replace / file_delete / file_move). Injected at construction
    # from the builtin registry (GRANTABLE ∩ FILESYSTEM) — see
    # tools.builtin.file_mutation_tool_names — so it is a single source of truth;
    # empty when not wired (the class grant then degrades to granting nothing).
    file_op_tools: frozenset[str] = frozenset()
    # GRANTABLE tools that must be confirmed PER CALL — a turn-wide「本轮内都允许」
    # (APPROVE_ALWAYS) grant is REFUSED for them, so the highest-risk side effect
    # (code_execute) re-prompts every call and a later injected-content-driven call
    # cannot ride an earlier grant (PI-004). Injected from the builtin registry
    # (GRANTABLE ∩ EXECUTION) — see tools.builtin.per_call_tool_names — so it is a
    # single source of truth; empty when not wired (then nothing is exempt).
    per_call_tools: frozenset[str] = frozenset()
    _granted: set[str] = field(default_factory=set)

    async def authorize(
        self, *, tool_name: str, tool_call_id: str, arguments: dict[str, Any]
    ) -> ApprovalDecision:
        """Block until the user authorizes (or denies) this tool call.

        ``APPROVE_ALWAYS`` also whitelists ``tool_name`` for the rest of the turn;
        ``APPROVE_ALWAYS_FILES`` whitelists the whole ``file_op_tools`` class. Both
        then sweep the matching calls already suspended on this gate. A tool in
        ``per_call_tools`` (code_execute) is exempt: an ``APPROVE_ALWAYS`` on it is
        downgraded to a one-shot ``APPROVE`` (never whitelisted), so it re-prompts each
        call (PI-004). A timeout is treated as ``DENY`` — a request is never silently
        allowed. An already-granted tool returns ``APPROVE`` immediately (no prompt).
        """
        if tool_name in self._granted:
            return ApprovalDecision.APPROVE

        approval_id = tool_call_id
        preview = _preview_arguments(tool_name, arguments)
        try:
            decision = await self.registry.suspend(
                approval_id,
                self.conversation_id,
                kind=InteractionKind.APPROVAL,
                payload={
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "arguments": preview,
                },
                timeout=self.timeout_seconds,
                on_suspended=lambda: self.sink.emit(
                    approval_required(
                        approval_id=approval_id,
                        conversation_id=self.conversation_id,
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        arguments=preview,
                    )
                ),
            )
        except TimeoutError:
            logger.info("approval.timeout", tool=tool_name, approval_id=approval_id)
            from agentcore.runtime.audit.hooks import on_approval_timeout

            on_approval_timeout(tool_name=tool_name, tool_call_id=tool_call_id)
            decision = ApprovalDecision.DENY

        if decision is ApprovalDecision.APPROVE_ALWAYS:
            if tool_name in self.per_call_tools:
                # A turn-wide grant is refused for a per-call tool (code_execute): the
                # user's click authorizes THIS call, but the tool is NOT whitelisted, so
                # the next call — possibly driven by injected content later in the turn —
                # prompts again (PI-004). Downgrade to a one-shot APPROVE; the client also
                # hides the「本轮内都允许」button for these tools, so this is defense in depth.
                logger.info(
                    "approval.turn_grant_refused", tool=tool_name, approval_id=approval_id
                )
                decision = ApprovalDecision.APPROVE
            else:
                self._granted.add(tool_name)
                self._sweep_pending_tools(frozenset({tool_name}))
        elif decision is ApprovalDecision.APPROVE_ALWAYS_FILES:
            # Grant the whole file-mutation class for the turn, and sweep every
            # already-suspended file-op call — so one click clears writes, edits,
            # deletes and moves together (code_execute is not in the class).
            self._granted.update(self.file_op_tools)
            self._sweep_pending_tools(self.file_op_tools)
        self.sink.emit(
            approval_resolved(
                approval_id=approval_id,
                tool_call_id=tool_call_id,
                decision=decision,
            )
        )
        from agentcore.runtime.audit.hooks import on_approval_resolved

        on_approval_resolved(
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            decision=decision.value,
            arguments=preview,
        )
        return decision

    def _sweep_pending_tools(self, tool_names: frozenset[str]) -> None:
        """Retroactively APPROVE every suspended call whose tool is in ``tool_names``.

        A grant whitelists tools via ``_granted``, but that only short-circuits calls
        that reach :meth:`authorize` AFTER the grant. In local mode this gate is
        shared by parallel workers, so several matching calls can already be suspended
        (each past the ``_granted`` check, awaiting its own Future) the instant the
        user clicks "allow for the turn" — without this they would each still need a
        click. The registry is the authoritative pending set, so sweeping it here
        closes the race the client cannot (its view is eventually-consistent over
        SSE). Resolving a sibling wakes its own ``authorize`` (which returns APPROVE
        and emits that call's own ``approval_resolved``); ``resolve`` is a no-op on an
        already-settled request, so this stays idempotent with the client's optimistic
        sibling-approve. The call being resolved right now is already discarded from
        the registry, so it is never in ``list_pending`` here.
        """
        if not tool_names:
            return
        swept: list[dict[str, str]] = []
        for req in self.registry.list_pending(self.conversation_id):
            if req.kind is not InteractionKind.APPROVAL:
                continue
            if req.payload.get("tool_name") not in tool_names:
                continue
            swept.append(
                {
                    "approval_id": req.id,
                    "tool_call_id": str(req.payload.get("tool_call_id") or ""),
                    "tool_name": str(req.payload.get("tool_name") or ""),
                }
            )
            self.registry.resolve(
                req.id, ApprovalDecision.APPROVE, conversation_id=self.conversation_id
            )
        if swept:
            from agentcore.runtime.audit.hooks import on_approval_swept

            on_approval_swept(tool_names=sorted(tool_names), swept=swept)
