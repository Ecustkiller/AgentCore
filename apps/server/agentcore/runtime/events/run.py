"""Multi-agent run and debate SSE event factories."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.types import EventType, SSEEvent


def run_plan(
    *,
    execution_id: str,
    plan_type: str,
    task_summary: str,
    agents: list[dict[str, Any]],
    runs: list[dict[str, Any]],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_PLAN,
        payload={
            "execution_id": execution_id,
            "plan_type": plan_type,
            "task_summary": task_summary,
            "agents": agents,
            "runs": runs,
        },
    )


def plan_revised(
    *,
    execution_id: str,
    revisions: list[dict[str, Any]],
) -> SSEEvent:
    """The CEO autonomously adjusted a paused plan via ``replan`` (受监督的波循环). Carries
    the affected run_ids + per-node ``kind`` (``bind`` = a late-bound placeholder finalised
    from upstream evidence; ``steer`` = a not-yet-run node re-steered after a scope deviation)
    so every end folds a non-interrupting「计划已调整」trace onto those graph nodes (设计 §7.2
    「计划已调整」轻痕迹). Emitted only when something actually changed (a no-op resume sends
    nothing); journaled, so the trace replays on reload."""
    return SSEEvent(
        type=EventType.PLAN_REVISED,
        payload={
            "execution_id": execution_id,
            "revisions": revisions,
        },
    )


def run_started(
    run_id: str,
    agent_id: str,
    *,
    parent_run_id: str | None = None,
    kind: str = "agent",
    revision: int = 0,
    stance: str | None = None,
    group: str | None = None,
    round_no: int = 0,
) -> SSEEvent:
    """A run began. A 续写 revision (辩手的后续轮) additionally carries its debater
    identity (``stance``/``group``) + its TRUE ``round`` so every fold projects 第几轮/
    哪一方 from a single source — round ≠ revision# once a side fails mid-debate, so the
    round is authoritative, not inferred from the version number. These three ride the
    payload ONLY when set (mirrors ``run_payload``), so an ordinary run / hot-fix
    revision keeps its byte-identical shape."""
    payload: dict[str, Any] = {
        "run_id": run_id,
        "agent_id": agent_id,
        "parent_run_id": parent_run_id,
        "kind": kind,
        "revision": revision,
    }
    if stance:
        payload["stance"] = stance
    if group:
        payload["group"] = group
    if round_no:
        payload["round"] = round_no
    return SSEEvent(type=EventType.RUN_STARTED, payload=payload)


def run_context(run_id: str, agent_id: str, blocks: list[dict[str, Any]]) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_CONTEXT,
        payload={"run_id": run_id, "agent_id": agent_id, "blocks": blocks},
    )


def run_output_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_OUTPUT_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_output_reset(run_id: str, agent_id: str) -> SSEEvent:
    """交付前核验回炉时清掉这个 worker 卡片已流式累积的草稿正文。

    ``content_reset`` 的 worker 对偶：done 轮正文已逐 token 经 ``run_output_delta`` emit 到
    run 节点，无法「收回」，故 finish_guard 命中回炉时发本事件——前端清该 agent 的
    ``outputChunks``，重写版重新流式，呈现为「违规版 → 修正版」一次干净替换而非追加。
    transport-only、不进 journal（重载时 worker 产出由 ``message_final`` fact 重建）。"""
    return SSEEvent(
        type=EventType.RUN_OUTPUT_RESET,
        payload={"run_id": run_id, "agent_id": agent_id},
    )


def run_reasoning_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_REASONING_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_tool_progress(run_id: str, agent_id: str, tool_name: str, chars: int) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_TOOL_PROGRESS,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "tool_name": tool_name,
            "chars": chars,
        },
    )


def escalation_raised(
    run_id: str,
    agent_id: str,
    *,
    question: str,
    assumption: str,
    blocking: bool,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_ESCALATION,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "question": question,
            "assumption": assumption,
            "blocking": blocking,
        },
    )


def team_note_posted(
    *,
    execution_id: str,
    note_id: str,
    run_id: str,
    agent_id: str,
    role: str,
    kind: str,
    text: str,
    ts: float,
    supersedes: str | None = None,
    supersede_mode: str | None = None,
) -> SSEEvent:
    """A worker pinned a note to the batch 便签墙 (§2.2 通). Carries the author (run/agent/
    role), the ``kind`` (``decision`` 我定了 / ``heads_up`` 提个醒) and the one-line ``text``,
    scoped by ``execution_id`` so the team-notes panel groups a turn's notes. Journaled (rides
    the delegate turn), so it replays on reload; folded onto the ProjectedTurn so both ends
    render it. ``note_id`` is the stable key (dedup).

    便签会过期 → supersession (§2.2): an AMENDMENT note also carries ``supersedes`` (the note_id
    it 改写/作废s) + ``supersede_mode`` (``update`` → target superseded / ``void`` → target
    voided). Those two are the single signal every fold uses to mark the TARGET stale — a fresh
    post omits them (kept off the payload so its shape is unchanged)."""
    payload: dict[str, Any] = {
        "execution_id": execution_id,
        "note_id": note_id,
        "run_id": run_id,
        "agent_id": agent_id,
        "role": role,
        "kind": kind,
        "text": text,
        "ts": ts,
    }
    # Only present on an amendment — a fresh post keeps its original payload shape (and existing
    # fixtures stay byte-identical for non-amendment notes).
    if supersedes is not None:
        payload["supersedes"] = supersedes
    if supersede_mode is not None:
        payload["supersede_mode"] = supersede_mode
    return SSEEvent(type=EventType.TEAM_NOTE_POSTED, payload=payload)


def run_completed(
    run_id: str,
    agent_id: str,
    *,
    output_summary: str,
    duration_ms: int,
    role: str = "member",
    model: str = "",
    usage: dict[str, int] | None = None,
    cost: dict[str, Any] | None = None,
    debrief: dict[str, Any] | None = None,
) -> SSEEvent:
    payload: dict[str, Any] = {
        "run_id": run_id,
        "agent_id": agent_id,
        "output_summary": output_summary,
        "duration_ms": duration_ms,
        "role": role,
        "model": model,
        "usage": usage
        if usage is not None
        else {"input": 0, "output": 0, "reasoning": 0, "cache_hit": 0, "cache_miss": 0},
        "cost": cost
        if cost is not None
        else {"input": 0, "cached": 0, "output": 0, "total": 0, "currency": "USD"},
    }
    # 完工交接简报 (surfacing): the worker's authored 交接简报 — {summary(结论) / key_points /
    # assumptions / next_steps}, each present only when non-empty — carried VERBATIM so the
    # run-detail 摘要 becomes the author's own wrap-up, not a machine truncation of raw prose.
    # Added ONLY when present (a 辩手 / trivial worker / the CEO writes none), so no-debrief
    # fixtures stay byte-identical and the client folds default it to null.
    if debrief:
        payload["debrief"] = debrief
    return SSEEvent(type=EventType.RUN_COMPLETED, payload=payload)


def run_failed(
    run_id: str, agent_id: str, error: str, *, debrief: dict[str, Any] | None = None
) -> SSEEvent:
    payload: dict[str, Any] = {"run_id": run_id, "agent_id": agent_id, "error": error}
    # 完工交接简报 on a FAILED run: a worker that produced a product + authored a 交接简报 but
    # missed its contract still has a useful wrap-up (结论/关键假设/建议下一步) — carried so the
    # run-detail shows the author's own conclusion next to the failure. Added ONLY when present
    # (infra-failure paths and the captain carry none), so no-debrief fixtures stay byte-identical
    # and the client folds default it to null.
    if debrief:
        payload["debrief"] = debrief
    return SSEEvent(type=EventType.RUN_FAILED, payload=payload)


def run_progress(completed: int, total: int) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_PROGRESS,
        payload={"completed": completed, "total": total},
    )


def batch_metrics(*, execution_id: str, metrics: dict[str, Any]) -> SSEEvent:
    """One WaveScheduler run's observability snapshot (调度埋点量化), surfaced for the
    client's 诊断模式 (前端UX设计.md §十「深层诊断指标」). ``metrics`` is the verbatim
    ``dataclasses.asdict`` of a :class:`~agentcore.runtime.runs.types.BatchMetrics`
    (nodes / width / peak_running / wall_ms / busy_ms / slot_starved / outcome counts /
    受监督波循环 boundary + escalate tallies) — carried snake_case as a wire-shaped leaf,
    folded onto the desktop ``Execution.batches`` and shown in run detail's 诊断信息. A
    delegate turn emits one per scheduler segment (a checkpoint/scope yield + resume emits
    another), so the fold accrues a list. Journaled (it rides a delegate turn alongside
    ``run_plan``), so it replays on reload; the mobile fold no-ops it (no diagnostic surface)."""
    return SSEEvent(
        type=EventType.BATCH_METRICS,
        payload={"execution_id": execution_id, **metrics},
    )


def debate_result(
    *,
    execution_id: str,
    moderator_run_id: str,
    payload: dict[str, Any],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_RESULT,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            **payload,
        },
    )


def debate_round_started(
    *,
    execution_id: str,
    moderator_run_id: str,
    round_no: int,
    focus: str,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_ROUND_STARTED,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            "round_no": round_no,
            "focus": focus,
        },
    )


def debate_round(
    *,
    execution_id: str,
    moderator_run_id: str,
    payload: dict[str, Any],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_ROUND,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            **payload,
        },
    )
