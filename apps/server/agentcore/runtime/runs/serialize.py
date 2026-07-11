"""JSON (de)serialization for a recoverable RunSession (P3 跨进程落盘).

Kept out of the in-memory types so the roster core stays import-light. The message
shape mirrors the OpenAI / DeepSeek wire form (role / content / tool_calls /
tool_call_id / reasoning_content) and round-trips back into :class:`LLMMessage`, so
``continue_run`` replays the exact context — including a worker's tool-call turns and
tool results — after loading from disk. :class:`RunSpec` is ``asdict``-ed and rebuilt
with its nested :class:`RunPolicy` / :class:`Deliverable` (``continue_run`` reads
``spec.deliverable``), tolerating unknown / missing keys so a later schema tweak
never breaks loading an older row.
"""

from __future__ import annotations

import json
from dataclasses import asdict, fields
from typing import Any

from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.session import RunSession
from agentcore.runtime.runs.types import (
    Deliverable,
    RunKind,
    RunOrigin,
    RunPhase,
    RunPolicy,
    RunSpec,
    RunState,
)


def _tool_call_to_dict(tc: ToolCall) -> dict[str, Any]:
    return {
        "id": tc.id,
        "type": tc.type,
        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
    }


def _tool_call_from_dict(d: dict[str, Any]) -> ToolCall:
    fn = d.get("function") or {}
    return ToolCall(
        id=str(d.get("id", "")),
        type=d.get("type", "function"),
        function=ToolCallFunction(
            name=str(fn.get("name", "")), arguments=str(fn.get("arguments", ""))
        ),
    )


def message_to_dict(m: LLMMessage) -> dict[str, Any]:
    """One transcript message → a compact JSON dict (omitting empty optionals)."""
    out: dict[str, Any] = {"role": m.role}
    if m.content is not None:
        out["content"] = m.content
    if m.tool_calls:
        out["tool_calls"] = [_tool_call_to_dict(tc) for tc in m.tool_calls]
    if m.tool_call_id:
        out["tool_call_id"] = m.tool_call_id
    if m.reasoning_content:
        out["reasoning_content"] = m.reasoning_content
    return out


def message_from_dict(d: dict[str, Any]) -> LLMMessage:
    tcs = d.get("tool_calls")
    return LLMMessage(
        role=d.get("role", "user"),
        content=d.get("content"),
        tool_calls=[_tool_call_from_dict(t) for t in tcs] if tcs else None,
        tool_call_id=d.get("tool_call_id"),
        reasoning_content=d.get("reasoning_content"),
    )


# Tools whose path argument names the file a worker creates or modifies. Used to
# derive a run's 文件产出 manifest from its transcript. Delete / move-away are
# intentionally excluded: the manifest answers "what did this worker produce",
# not a full mutation audit (a deleted path is not a deliverable).
_FILE_PRODUCT_ARG: dict[str, str] = {
    "file_write": "path",
    "file_append": "path",
    "str_replace": "path",
    "file_move": "destination",
}


def files_touched_from_transcript(transcript: list[LLMMessage]) -> list[str]:
    """Best-effort list of workspace paths a worker created/modified, first-seen order.

    Parsed from the transcript's file-tool calls (file_write / file_append /
    str_replace / file_move). Intent-level: a call with malformed args is skipped, but a path is
    listed from the call itself (we do not cross-check the tool result) — so the CEO
    is told to re-verify only if the manifest looks empty or incomplete. A file
    written indirectly (e.g. by a code_execute script) is invisible here.
    """
    seen: list[str] = []
    for msg in transcript:
        if msg.role != "assistant" or not msg.tool_calls:
            continue
        for tc in msg.tool_calls:
            arg = _FILE_PRODUCT_ARG.get(tc.function.name)
            if not arg:
                continue
            try:
                parsed = json.loads(tc.function.arguments or "{}")
            except (ValueError, TypeError):
                continue
            path = parsed.get(arg) if isinstance(parsed, dict) else None
            if isinstance(path, str) and path.strip() and path.strip() not in seen:
                seen.append(path.strip())
    return seen


def escalations_from_transcript(transcript: list[LLMMessage]) -> list[dict[str, Any]]:
    """Best-effort list of a worker's escalations (``escalate`` tool calls), call order.

    Each item is ``{question, assumption, blocking, kind, status, answer}`` parsed from
    the call's arguments (assumption defaults to "", blocking to False, kind to
    ``"normal"``). ``kind="scope"`` (职责/范围偏离) and ``kind="dep"`` (依赖缺口·卡在缺输入 X,
    §2.4) are BOTH consumed by the WaveScheduler at the reactive wave boundary
    (``BoundaryReason.SCOPE``) so the CEO re-steers / replan(add)s the not-yet-run tail
    (执行引擎架构设计.md §受监督的波循环); ``"normal"`` is an ordinary 待决问题 resolved at
    synthesis. ``status`` defaults to ``"raised"`` (a non-blocking escalate, or a blocking
    one that degraded) with no ``answer``; the executor overrides these to ``"resolved"``
    / ``"assumed"`` / ``"timed_out"`` for a blocking escalate that actually suspended (阻塞式求
    决策 §4.7). Mirrors
    :func:`files_touched_from_transcript`: intent-level, read off the call itself; a call
    with malformed args or an empty ``question`` is skipped. The DelegateTool surfaces
    these to the CEO as「队员升级了待决问题」so it resolves them before finalizing.
    The tool name is the literal ``"escalate"`` (= ``ESCALATE_TOOL_NAME``); kept inline
    here to keep this serialization module dependency-light, as the file-tool names are.
    """
    out: list[dict[str, Any]] = []
    for msg in transcript:
        if msg.role != "assistant" or not msg.tool_calls:
            continue
        for tc in msg.tool_calls:
            if tc.function.name != "escalate":
                continue
            try:
                parsed = json.loads(tc.function.arguments or "{}")
            except (ValueError, TypeError):
                continue
            if not isinstance(parsed, dict):
                continue
            question = str(parsed.get("question") or "").strip()
            if not question:
                continue
            kind = str(parsed.get("kind") or "normal").strip().lower()
            if kind not in ("normal", "scope", "dep"):
                kind = "normal"
            out.append(
                {
                    "question": question,
                    "assumption": str(parsed.get("assumption") or "").strip(),
                    "blocking": bool(parsed.get("blocking")),
                    # 执行引擎架构设计.md §受监督的波循环: "scope" (职责/范围偏离) and "dep"
                    # (依赖缺口·卡在缺输入 X, §2.4) are BOTH consumed at the reactive wave
                    # boundary — the CEO re-steers ("scope") / replan(add)s a producer ("dep")
                    # for the un-run tail; "normal" is an ordinary 待决问题 resolved at synthesis.
                    "kind": kind,
                    # 阻塞式求决策: lifecycle of a blocking escalate. Default for a
                    # non-blocking / degraded one; the executor folds in the user's
                    # resolution for one that suspended (设计 §4.7).
                    "status": "raised",
                    "answer": None,
                }
            )
    return out


# 完工交接简报 (worker → 下游/CEO): a delegated worker ends its run by calling the terminal
# ``handoff`` tool with a STRUCTURED brief (summary / key_points / assumptions / next_steps) — a
# wrap-up for its READERS, not more deliverable prose. Because it is structured, it is read
# STRAIGHT OFF the call's arguments here (never parsed back out of markdown prose — its former,
# fragile「## 交接简报」form): a downstream dep block can LEAD with the author's own 结论 (cheapest
# to read, survives budget-trim) and the CEO aggregate can surface 建议下一步 to relay to the user,
# instead of every reader re-deriving the gist from raw prose. Same discipline as the sibling
# transcript harvesters (escalations_from_transcript / files_touched_from_transcript): intent-level,
# pure, unit-testable. Nodes with downstream dependents **require** a minimum-quality handoff
# (executor injects one correction shot; still missing → synthesize_debrief with ``degraded``);
# leaf nodes (no dependents) may finish without handoff and degrade to ``None``.
#
# The tool name is the literal ``"handoff"`` (= ``HANDOFF_TOOL_NAME``); kept inline here to keep
# this serialization module dependency-light, exactly as ``escalations_from_transcript`` keeps
# ``"escalate"`` and the file harvester keeps its file-tool names inline.
def _debrief_from_handoff_args(args: dict[str, Any]) -> dict[str, Any] | None:
    """A ``handoff`` call's arguments → the debrief dict, or None when it carried nothing usable.

    Only the fields the author actually filled are kept (each omitted when empty), matching the
    shape the run-detail card / dep injection / CEO synthesis already consume. ``key_points`` is a
    list (a lone string is tolerated by wrapping it); the other three are single strings."""
    out: dict[str, Any] = {}
    summary = str(args.get("summary") or "").strip()
    if summary:
        out["summary"] = summary
    raw_points = args.get("key_points")
    if isinstance(raw_points, str):
        raw_points = [raw_points]
    key_points = [str(p).strip() for p in (raw_points or []) if str(p).strip()]
    if key_points:
        out["key_points"] = key_points
    assumptions = str(args.get("assumptions") or "").strip()
    if assumptions:
        out["assumptions"] = assumptions
    next_steps = str(args.get("next_steps") or "").strip()
    if next_steps:
        out["next_steps"] = next_steps
    return out or None


def debrief_from_transcript(transcript: list[LLMMessage]) -> dict[str, Any] | None:
    """The worker's 交接简报, harvested from its ``handoff`` tool call, or None.

    Walks the transcript for ``handoff`` calls and parses the LAST valid one's arguments (a
    re-worked / revised run may submit more than once — the final brief wins). Mirrors
    :func:`escalations_from_transcript`: read off the call itself, a call with malformed args or
    no usable field is skipped. None when there is no ``handoff`` call at all."""
    result: dict[str, Any] | None = None
    for msg in transcript:
        if msg.role != "assistant" or not msg.tool_calls:
            continue
        for tc in msg.tool_calls:
            if tc.function.name != "handoff":
                continue
            try:
                parsed = json.loads(tc.function.arguments or "{}")
            except (ValueError, TypeError):
                continue
            if not isinstance(parsed, dict):
                continue
            debrief = _debrief_from_handoff_args(parsed)
            if debrief is not None:
                result = debrief  # last valid handoff wins
    return result


def transcript_to_json(transcript: list[LLMMessage]) -> list[dict[str, Any]]:
    return [message_to_dict(m) for m in transcript]


def transcript_from_json(data: list[dict[str, Any]] | None) -> list[LLMMessage]:
    return [message_from_dict(d) for d in (data or [])]


def _filtered(cls: type, data: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only keys that are real fields of ``cls`` — tolerate schema drift so a
    row written by an older/newer build still loads."""
    names = {f.name for f in fields(cls)}
    return {k: v for k, v in (data or {}).items() if k in names}


def spec_to_json(spec: RunSpec) -> dict[str, Any]:
    """RunSpec → JSON dict. ``asdict`` recurses into RunPolicy / Deliverable; the
    StrEnum ``kind`` serializes as its string value through JSONB."""
    return asdict(spec)


def spec_from_json(data: dict[str, Any]) -> RunSpec:
    """Rebuild a RunSpec (with nested RunPolicy / Deliverable) from its JSON dict."""
    data = dict(data or {})
    policy_raw = dict(data.pop("policy", None) or {})
    policy = RunPolicy(**_filtered(RunPolicy, policy_raw))
    deliverable_raw = data.pop("deliverable", None)
    deliverable: Deliverable | None = None
    if isinstance(deliverable_raw, dict):
        fields = _filtered(Deliverable, deliverable_raw)
        name = fields.get("name", "")
        fields["name"] = name.strip() if isinstance(name, str) else ""
        deliverable = Deliverable(**fields)
    kwargs = _filtered(RunSpec, data)
    kwargs["policy"] = policy
    if deliverable is not None:
        kwargs["deliverable"] = deliverable
    kind = kwargs.get("kind")
    if isinstance(kind, str):
        kwargs["kind"] = RunKind(kind)
    return RunSpec(**kwargs)


def state_to_json(state: RunState) -> dict[str, Any]:
    """A RunState → compact JSON for a paused-turn seed (结构化挂起 durable resume).

    Carries exactly what a resume needs to treat a node as already-finished: its
    ``phase`` + product (downstream reads ``content``) plus the priced
    ``usage``/``cost``/``citations`` so the resumed turn bills the pre-pause work
    ONCE (it was never billed — the turn paused before persistence) and folds its
    tokens/sources into the totals. The heavy ``transcript`` is intentionally
    dropped: a seed_completed node is never re-run or revised, downstream reads only
    its ``content`` — so the frame stays light.
    """
    return {
        "phase": state.phase.value,
        "content": state.content,
        "reasoning": state.reasoning,
        "error": state.error,
        # 确定性失败区分 (BL-6): persist the retryable verdict so a resume / retry-failed
        # rebuild + the audit trail keep the「这次失败是确定性的」signal (default True keeps
        # older frames unchanged). Omitted from the shape for COMPLETED nodes is fine — the
        # deserializer defaults it True.
        "error_retryable": state.error_retryable,
        "warnings": list(state.warnings),
        "escalations": [dict(e) for e in state.escalations],
        "citations": list(state.citations),
        "model": state.model,
        "duration_ms": state.duration_ms,
        "rounds": state.rounds,
        "files_touched": list(state.files_touched),
        "debrief": dict(state.debrief) if state.debrief else None,
        "intake": dict(state.intake) if state.intake else None,
        "usage": dict(state.usage),
        "cost": dict(state.cost),
    }


def state_from_json(data: dict[str, Any]) -> RunState:
    """Rebuild a (seed) RunState from :func:`state_to_json`; tolerates missing keys
    so an older/newer frame still loads."""
    data = dict(data or {})
    phase = data.get("phase")
    return RunState(
        phase=RunPhase(phase) if isinstance(phase, str) else RunPhase.COMPLETED,
        content=data.get("content", "") or "",
        reasoning=data.get("reasoning", "") or "",
        error=data.get("error", "") or "",
        error_retryable=bool(data.get("error_retryable", True)),
        warnings=list(data.get("warnings") or []),
        escalations=[dict(e) for e in (data.get("escalations") or []) if isinstance(e, dict)],
        citations=list(data.get("citations") or []),
        model=data.get("model", "") or "",
        duration_ms=int(data.get("duration_ms", 0) or 0),
        rounds=int(data.get("rounds", 0) or 0),
        files_touched=list(data.get("files_touched") or []),
        debrief=data.get("debrief") if isinstance(data.get("debrief"), dict) else None,
        intake=data.get("intake") if isinstance(data.get("intake"), dict) else None,
        usage=dict(data.get("usage") or {}),
        cost=dict(data.get("cost") or {}),
    )


def plan_to_json(plan: RunPlan) -> dict[str, Any]:
    """A RunPlan → JSON ({nodes, origin}) so a paused turn rebuilds the EXACT graph
    — with its already-minted run_ids — on resume. Re-deriving from the delegate
    args would mint fresh ids (``del_<uuid>_N``) that no longer match the
    seed_completed map keyed by the original ids."""
    return {
        "nodes": [spec_to_json(n) for n in plan.nodes],
        "origin": plan.origin.value,
    }


def plan_from_json(data: dict[str, Any]) -> RunPlan:
    """Rebuild a RunPlan from :func:`plan_to_json`."""
    data = dict(data or {})
    origin = data.get("origin")
    plan = RunPlan(nodes=[spec_from_json(n) for n in (data.get("nodes") or [])])
    if isinstance(origin, str):
        plan.origin = RunOrigin(origin)
    return plan


def state_map_to_json(completed: dict[str, RunState]) -> dict[str, dict[str, Any]]:
    """The scheduler's completed map (run_id → RunState) → JSON for a paused frame."""
    return {run_id: state_to_json(state) for run_id, state in completed.items()}


def state_map_from_json(data: dict[str, Any] | None) -> dict[str, RunState]:
    """Rebuild the completed map (seed_completed) from :func:`state_map_to_json`."""
    return {run_id: state_from_json(raw) for run_id, raw in (data or {}).items()}


def run_final_fact(run_id: str, state: RunState) -> Any:
    """A worker run's terminal RunState as a ``message_final`` journal fact.

    执行级事件溯源 Phase 2 ⑥ (``frame.completed`` 的事实来源): the payload **is**
    :func:`state_to_json` (the exact seed shape the frame stored) keyed by ``run_id`` and
    tagged by its ``phase``, so :func:`agentcore.runtime.journal.completed_from_journal`
    rebuilds the scheduler seed map with the SAME deserializer (:func:`state_from_json`) —
    zero drift between the (being-removed) ``paused_turns.frame`` blob and its journal
    projection. Recorded for EVERY terminal worker (COMPLETED / FAILED) at the executor's
    single run choke point, so a resume re-seeds finished nodes from facts, never the旁路
    frame. ``message_final`` (vs a new kind) keeps the §8.3 execution-kind set stable; the
    captain's own ``message_final`` (content/reasoning, no ``phase``) is NOT a seed and is
    skipped by the projection.
    """
    from agentcore.runtime.facts import Fact, FactKind

    return Fact(
        kind=FactKind.MESSAGE_FINAL.value,
        payload={"run_id": run_id, **state_to_json(state)},
    )


def plan_snapshot_fact(plan: RunPlan) -> Any:
    """A delegate's full DAG as a ``plan_snapshot`` journal fact (执行级事件溯源 Phase 2).

    The execution source for ``frame.plan`` (its exit): the payload **is**
    :func:`plan_to_json` (the exact graph the frame stored — every :class:`RunSpec` with
    its minted run_id, accumulated ``steer`` and policy/contract), so
    :func:`agentcore.runtime.journal.plan_from_journal` rebuilds it with the SAME
    deserializer (:func:`plan_from_json`) — zero drift between the (being-removed) blob and
    its journal projection (the conformance golden gates this ``==``). Recorded at plan
    build AND after each ``adjust`` steer, so the LAST snapshot reflects the cumulative
    plan (steer accumulates across checkpoints); the projector takes the last one,
    last-write-wins. A distinct kind from the display ``run_plan`` event keeps the display
    projection's surface gate untouched.
    """
    from agentcore.runtime.facts import Fact, FactKind

    return Fact(kind=FactKind.PLAN_SNAPSHOT.value, payload=plan_to_json(plan))


def session_to_row(session: RunSession) -> dict[str, Any]:
    """The persisted columns for a RunSession (``conversation_id`` is attached by the
    repository from the turn envelope, not stored on the in-memory session)."""
    return {
        "run_id": session.run_id,
        "spec": spec_to_json(session.spec),
        "transcript": transcript_to_json(session.transcript),
        "content": session.content,
        "recall_count": session.recall_count,
        # partial is in-memory only (redirect salvage); durable rows are completed sessions.
    }


def session_from_row(row: Any) -> RunSession:
    """Rebuild a RunSession from a ``RunSessionRow`` (attribute access)."""
    return RunSession(
        run_id=row.run_id,
        spec=spec_from_json(row.spec),
        transcript=transcript_from_json(row.transcript),
        content=row.content or "",
        recall_count=row.recall_count or 0,
        partial=False,
    )
