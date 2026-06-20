"""SSE event type definitions and EventSink.

Events flow from the engine → asyncio.Queue → SSE StreamingResponse → client.
The EventSink decouples execution from delivery (backpressure-safe).
"""

import asyncio
import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from agentcore.runtime.facts import Fact, record_turn_fact


class EventType(StrEnum):
    MESSAGE_START = "message_start"
    CONTENT_DELTA = "content_delta"
    # 交付前核验回炉（finish_guard）：CEO 自报 done 的正文未过轻层核验（如编造引用），引擎
    # 丢弃这一版、回炉重写，并发此事件让客户端清空当前流式气泡已累积的正文，再接收重写版的
    # content_delta，使「违规版 → 修正版」呈现为一次干净替换而非追加。Transport-only（不在
    # _JOURNAL_EVENT_TYPES）：纯对话回合的历史回放用最终 message content（已是修正版），有
    # 工具回合靠 _accumulate_process 同步 pop 掉被丢弃的那版正文。
    CONTENT_RESET = "content_reset"
    REASONING_DELTA = "reasoning_delta"
    # The CEO captain is composing a tool call's ARGUMENTS (e.g. the delegate 任务书).
    # Bubble-scoped twin of run_tool_progress (which is run-scoped, for workers): the
    # captain's voice streams to the chat bubble, and its big delegate call assembles
    # BEFORE run_plan fires (no graph yet), so this drives a live「正在生成 {tool}…」
    # line on the assistant bubble. Transport-only liveliness — NOT journaled.
    TOOL_PROGRESS = "tool_progress"
    TOOL_USE_START = "tool_use_start"
    TOOL_USE_END = "tool_use_end"
    MESSAGE_END = "message_end"
    ERROR = "error"
    TITLE_GENERATED = "title_generated"
    TURN_SAVED = "turn_saved"
    CITATIONS = "citations"
    # Tool approval gate (CEO chat path): a GRANTABLE tool is paused awaiting the
    # user's decision, then resolved.
    APPROVAL_REQUIRED = "approval_required"
    APPROVAL_RESOLVED = "approval_resolved"
    # User checkpoint (CEO ask_user): the CEO paused the turn to ask the user —
    # the one「向用户发问」surface, covering BOTH an opening 引导 (a producible-but-
    # underspecified request → 起步计划 + ≤5 重点问题 + style options) and a mid-task
    # fork (A/B / irreversible step). Either way the turn suspends and resolves
    # (continue / stop). UNLIKE approvals (pure transport), these two are journaled
    # (see _JOURNAL_EVENT_TYPES) so the question + answer replay inline on reload —
    # the exchange is conversation, not just gating.
    CHECKPOINT_REQUIRED = "checkpoint_required"
    CHECKPOINT_RESOLVED = "checkpoint_resolved"
    # Non-blocking ask (ask_user blocking=false, Cursor 式): the CEO surfaced a
    # question it already has a default for and KEPT WORKING — no suspend, no resolve.
    # Carries the same rich shape as a checkpoint, but it never gates the turn: the
    # client renders a non-gating card whose chips 回填 the composer (the user's answer
    # rides an ordinary next-turn message). Journaled so it replays inline on reload;
    # there is no paired「resolved」(it was never pending). 见 tools/builtin/ask_user.py.
    QUESTION_POSTED = "question_posted"
    # Structured DAG checkpoint (结构化挂起 2a): a delegate step marked
    # ``checkpoint_after`` completed and the WaveScheduler paused at the wave
    # boundary before its dependents, awaiting the user's plan_review (continue /
    # stop). Distinct from ask_user (CEO mid-loop) — this is plan-declared and
    # scheduler-enforced. Journaled like checkpoints so the pause replays on reload.
    PLAN_REVIEW_REQUIRED = "plan_review_required"
    PLAN_REVIEW_RESOLVED = "plan_review_resolved"
    # Local-workspace op channel (双模式工作区 P2): a server-side LocalWorkspace
    # asks the bound desktop client to run a file/exec op against the real local
    # directory, then awaits the result posted back to the ops resolve endpoint.
    # Transport only — deliberately NOT journaled into the team graph.
    WORKSPACE_OP_REQUIRED = "workspace_op_required"
    # 裸聊懒升级（文件夹即工作区 §懒建 / 工作区对称化 D1a）：a folderless 裸聊's first
    # file write minted a real folder and filed the conversation into it. Without this
    # signal the promotion is invisible to the live client — the chat stays in 未分组
    # and the new workspace + its file only surface on a manual refetch / reload. Tells
    # the client to re-group the chat under the new folder and surface it in the 文件
    # rail. One-shot: the folder is durable state read back on reload, so this is NOT
    # journaled (it only closes the mid-turn stale window).
    WORKSPACE_PROMOTED = "workspace_promoted"
    # Local→云 handoff (双模式工作区 P2e / e1): a local workspace was archived over
    # the channel and snapshotted to object storage; carries the new snapshot id.
    # One-shot completion signal — not journaled into the team graph.
    HANDOFF_SNAPSHOT_DONE = "handoff_snapshot_done"
    # Local→云 handoff dispatch (双模式工作区 P2e / e2): the base snapshot was taken
    # and a cloud job accepted; carries the job id so the client can start polling
    # its status. The team run continues detached after this SSE closes.
    HANDOFF_JOB_STARTED = "handoff_job_started"
    # Local→云 handoff apply (双模式工作区 P2e / e3): the selected result changes were
    # written back to the local workspace over the channel; carries the per-file
    # outcome (applied / skipped / conflict / error) + counts. One-shot completion
    # signal emitted just before the apply SSE closes — not journaled.
    HANDOFF_APPLY_DONE = "handoff_apply_done"
    # Multi-agent execution events (CEO delegate path)
    RUN_PLAN = "run_plan"
    RUN_STARTED = "run_started"
    # 收到的上下文 (上下文传递可视化): the structured ContextBlock list a run's opening was
    # assembled from — the same data the LLM was fed (单一源), emitted right after
    # run_started so the frontend shows exactly what each worker received (原始请求 / 团队
    # 位置 / 前置结果 / 工作区 / 任务…). Journaled (see _JOURNAL_EVENT_TYPES) so a past
    # turn's received context replays on reload through the same fold as the live stream.
    RUN_CONTEXT = "run_context"
    RUN_OUTPUT_DELTA = "run_output_delta"
    RUN_REASONING_DELTA = "run_reasoning_delta"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    RUN_PROGRESS = "run_progress"
    # A worker is streaming a tool call's ARGUMENTS (e.g. the file body for
    # file_write). Those bytes are neither content (run_output_delta) nor reasoning
    # (run_reasoning_delta), and tool_use_start only fires once they fully assemble
    # — so without this a file-writing worker's node sits frozen for the whole
    # (often minute-long) write. Transport-only liveliness: throttled by argument
    # growth and deliberately NOT journaled (a reloaded run shows the finished call
    # via the journaled tool_use_start/end — live progress is moot by then).
    RUN_TOOL_PROGRESS = "run_tool_progress"
    # 辩论编排（debate 工具 / 主持人）：一场辩论收场时 emit 的【完整结构化产物】——逐轮
    # 焦点 / 裁判 / 小结（交锋叙事线 L1/L2）+ 决策简报（结论卡）+ 各方→辩手 run_id 映射
    # （前端据此从执行图的辩手节点取发言全文 L3，不把全文塞进本事件）。进 journal（与
    # run_plan 同属 surface 的辩论回合，runs_from_entries 原样回放）；前端按 plan_type=
    # "debate" 把主持人 / 辩手节点折叠成辩论专属视图，本事件供其渲染简报与三层叙事线。
    DEBATE_RESULT = "debate_result"
    # 辩论逐轮增量（主持人驱动）——让前端进行中就看到主持人的逐轮编排，而非干等收场。
    # DEBATE_ROUND_STARTED 在本轮辩手发言【前】emit（携 round_no + 本轮焦点 focus）：焦点先于
    # 发言亮出；DEBATE_ROUND 在本轮裁判 + 小结产出【后】emit（携完整一轮 focus/summary/verdict
    # + 各方→辩手 run_id）。二者均 transport-only（不在 _JOURNAL_EVENT_TYPES）：重载由收场的
    # debate_result 重建全量叙事线，逐轮事件只服务进行中的实时叠加（仍进 _history，断线重连可
    # 重放）。前端 fold 累积成 ProjectedTurn.debateRounds，与 debate_result（debate）互补。
    DEBATE_ROUND_STARTED = "debate_round_started"
    DEBATE_ROUND = "debate_round"


class FinishReason(StrEnum):
    END_TURN = "end_turn"
    MAX_ROUNDS = "max_rounds"
    # The model kept returning empty responses (no content, no tool call) even after
    # the fallback retry — ended degraded rather than blank (B2).
    DEGRADED = "degraded"
    # Early-stopped a run of consecutive rounds where every tool call failed and no
    # content was produced — salvaged a forced tool-free answer (B2 无产出早停).
    UNPRODUCTIVE = "unproductive"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class SSEEvent:
    """A single event to be sent over the SSE stream."""

    type: EventType
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def message_start(message_id: str, *, conversation_id: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.MESSAGE_START,
        payload={"message_id": message_id, "conversation_id": conversation_id},
    )


def content_delta(delta: str) -> SSEEvent:
    return SSEEvent(type=EventType.CONTENT_DELTA, payload={"delta": delta})


def content_reset() -> SSEEvent:
    """交付前核验回炉信号：丢弃当前流式气泡已累积的正文，准备接收重写版。

    finish_guard 在 CEO 自报 done 时拦下未过核验的正文（如编造引用），引擎退回累积正文、
    注入修正提示、回炉重写。客户端收到后清空当前 assistant 气泡的尾部正文（镜像后端
    ``_accumulate_process`` 的 pop），使「违规版 → 修正版」呈现为一次干净替换而非追加。
    """
    return SSEEvent(type=EventType.CONTENT_RESET)


def reasoning_delta(delta: str) -> SSEEvent:
    return SSEEvent(type=EventType.REASONING_DELTA, payload={"delta": delta})


def tool_progress(tool_name: str, chars: int) -> SSEEvent:
    """The CEO captain is actively composing a tool call's arguments (bubble-scoped).

    ``chars`` is the cumulative length of the streamed argument string so far — for
    the prime case (``delegate``) that is the task book growing. The captain's voice
    is the chat bubble (not run-scoped), and its big delegate call assembles BEFORE
    ``run_plan`` fires (no team graph yet), so a run-scoped ``run_tool_progress``
    would be dropped client-side. This turn-scoped twin instead drives a live
    「正在生成 {tool}…」line on the assistant bubble. Transport-only (not journaled):
    once the call executes, the bubble's content / the team graph takes over.
    """
    return SSEEvent(
        type=EventType.TOOL_PROGRESS,
        payload={"tool_name": tool_name, "chars": chars},
    )


def tool_use_start(tool_call_id: str, tool_name: str, arguments: dict[str, Any]) -> SSEEvent:
    return SSEEvent(
        type=EventType.TOOL_USE_START,
        payload={
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "arguments": arguments,
        },
    )


def citations_event(citations: list[dict[str, Any]]) -> SSEEvent:
    """Aggregated, de-duplicated web sources consulted during the turn.

    Emitted once near end-of-turn (before ``message_end``) so the client attaches
    source cards to the just-finished assistant message. Each entry is a
    ``{url, title, snippet, site}`` dict. Persisted on the message too, so reload
    replays the same cards.
    """
    return SSEEvent(type=EventType.CITATIONS, payload={"citations": citations})


# A tool's structured ``display`` payload (工具结果富渲染) is persisted in the
# journal / process timeline, so — like the model-facing ``result`` — it is
# size-capped before it enters them (the live SSE carries this same capped form;
# a card needs a preview, not megabytes). Long string fields are clamped and
# over-long lists trimmed, recursively, so a code_execute dumping a huge stdout or
# a search returning many hits can't bloat the message row.
_DISPLAY_STR_CAP = 6000
_DISPLAY_LIST_CAP = 50


def _cap_display_value(value: Any) -> Any:
    if isinstance(value, str):
        return value[:_DISPLAY_STR_CAP] + "…" if len(value) > _DISPLAY_STR_CAP else value
    if isinstance(value, list):
        return [_cap_display_value(v) for v in value[:_DISPLAY_LIST_CAP]]
    if isinstance(value, dict):
        return {k: _cap_display_value(v) for k, v in value.items()}
    return value


def _cap_display(display: dict[str, Any] | None) -> dict[str, Any] | None:
    """Bound a tool's structured ``display`` before it is journaled / persisted."""
    if not display:
        return None
    return {k: _cap_display_value(v) for k, v in display.items()}


def tool_use_end(
    tool_call_id: str,
    tool_name: str,
    *,
    success: bool,
    output: str,
    display: dict[str, Any] | None = None,
) -> SSEEvent:
    payload: dict[str, Any] = {
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "status": "success" if success else "error",
        "result": output,
    }
    capped = _cap_display(display)
    if capped is not None:
        payload["display"] = capped
    return SSEEvent(type=EventType.TOOL_USE_END, payload=payload)


def approval_required(
    *,
    approval_id: str,
    conversation_id: str,
    tool_call_id: str,
    tool_name: str,
    arguments: dict[str, Any],
) -> SSEEvent:
    """A GRANTABLE tool call is paused, awaiting the user's authorization.

    ``approval_id`` is the key the client echoes back to the resolve endpoint
    (it equals ``tool_call_id``). ``arguments`` is a size-bounded preview so the
    user can see what the tool would do before allowing it.
    """
    return SSEEvent(
        type=EventType.APPROVAL_REQUIRED,
        payload={
            "approval_id": approval_id,
            "conversation_id": conversation_id,
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "arguments": arguments,
        },
    )


def approval_resolved(*, approval_id: str, tool_call_id: str, decision: str) -> SSEEvent:
    """A pending approval was settled (approve / approve_always / deny / timeout).

    Lets the client clear the inline prompt; ``decision`` mirrors the resolution
    (a timeout resolves as ``deny``).
    """
    return SSEEvent(
        type=EventType.APPROVAL_RESOLVED,
        payload={
            "approval_id": approval_id,
            "tool_call_id": tool_call_id,
            "decision": decision,
        },
    )


def checkpoint_required(
    *,
    checkpoint_id: str,
    conversation_id: str,
    question: str,
    context: str = "",
    assumptions: list[dict[str, Any]] | None = None,
    questions: list[dict[str, Any]] | None = None,
    style_options: list[dict[str, Any]] | None = None,
) -> SSEEvent:
    """The CEO paused the turn to ask the user (ask_user — the one asking surface).

    One adaptive shape for both an opening 引导 and a mid-task fork. ``checkpoint_id``
    is the key the client echoes back to the resolve endpoint. ``question`` is the
    CEO-authored framing / opening line (the tool's ``message`` — always shown);
    ``context`` is optional supporting background. The rich opening content is
    optional (empty for a compact mid-task fork): ``assumptions`` are the 起步计划
    chips (``{id, label, value}`` — low-impact decisions the CEO made for the user,
    read-only); ``questions`` are the ≤5 askable items (``{id, prompt, kind, options,
    multiple, default}`` — each pre-fillable so a 想省事 user one-clicks through);
    ``style_options`` are the optional 风格预设 (``{id, label}`` — visual products
    only). Journaled (see ``_JOURNAL_EVENT_TYPES``) so a reload replays the prompt
    inline.
    """
    return SSEEvent(
        type=EventType.CHECKPOINT_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "conversation_id": conversation_id,
            "question": question,
            "context": context,
            "assumptions": assumptions or [],
            "questions": questions or [],
            "style_options": style_options or [],
        },
    )


def question_posted(
    *,
    ask_id: str,
    conversation_id: str,
    question: str,
    context: str = "",
    assumptions: list[dict[str, Any]] | None = None,
    questions: list[dict[str, Any]] | None = None,
    style_options: list[dict[str, Any]] | None = None,
) -> SSEEvent:
    """Non-blocking ask (ask_user blocking=false): surface a question, never suspend.

    Same rich shape as :func:`checkpoint_required` (so the client reuses the card body)
    but it is NOT a checkpoint: the turn does not pause and there is no resolve — the
    CEO has already proceeded on its stated default (``assumptions`` / a question
    ``default``). The client renders a non-gating card whose option chips 回填 the
    composer; the user's answer, if any, rides an ordinary next-turn message. ``ask_id``
    keys the card (dedupe a re-delivered event). Journaled (see ``_JOURNAL_EVENT_TYPES``)
    so a reload replays it inline.
    """
    return SSEEvent(
        type=EventType.QUESTION_POSTED,
        payload={
            "ask_id": ask_id,
            "conversation_id": conversation_id,
            "question": question,
            "context": context,
            "assumptions": assumptions or [],
            "questions": questions or [],
            "style_options": style_options or [],
        },
    )


def checkpoint_resolved(
    *, checkpoint_id: str, decision: str, note: str = "", selected: list[str] | None = None
) -> SSEEvent:
    """A pending checkpoint was settled (continue / adjust / stop / timeout).

    Lets the client flip the inline card to its resolved state; ``note`` carries
    the user's steer for ``adjust`` (or a closing remark for ``stop``), ``selected``
    the option(s) the user picked. Journaled alongside ``checkpoint_required`` so
    the settled outcome replays on reload.
    """
    return SSEEvent(
        type=EventType.CHECKPOINT_RESOLVED,
        payload={
            "checkpoint_id": checkpoint_id,
            "decision": decision,
            "note": note,
            "selected": selected or [],
        },
    )


def plan_review_required(
    *,
    checkpoint_id: str,
    conversation_id: str,
    steps: list[dict[str, Any]],
    pending: list[dict[str, Any]],
) -> SSEEvent:
    """A DAG ``checkpoint_after`` step finished; the scheduler paused for the user
    to review before its dependents run (结构化挂起 2a).

    ``checkpoint_id`` is the key the client echoes back to the resolve endpoint.
    ``steps`` are the just-completed checkpoint nodes (``{run_id, role, summary}``)
    the user is reviewing; ``pending`` is a peek at the downstream nodes about to
    run (``{run_id, role}``) so the card frames「看着已发生的、决定要不要放行未发生
    的」. Journaled (see ``_JOURNAL_EVENT_TYPES``) so the pause replays inline on
    reload.
    """
    return SSEEvent(
        type=EventType.PLAN_REVIEW_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "conversation_id": conversation_id,
            "steps": steps,
            "pending": pending,
        },
    )


def plan_review_resolved(*, checkpoint_id: str, decision: str, note: str = "") -> SSEEvent:
    """A pending plan_review was settled (continue / stop / timeout).

    Lets the client flip the inline card to its resolved state; ``note`` carries an
    optional remark. Journaled alongside ``plan_review_required`` so the settled
    outcome replays on reload.
    """
    return SSEEvent(
        type=EventType.PLAN_REVIEW_RESOLVED,
        payload={
            "checkpoint_id": checkpoint_id,
            "decision": decision,
            "note": note,
        },
    )


def workspace_op_required(
    *,
    request_id: str,
    conversation_id: str,
    root_id: str,
    op: str,
    args: dict[str, Any],
) -> SSEEvent:
    """A local-workspace op is paused, awaiting the desktop client to run it.

    The server-side ``LocalWorkspace`` cannot touch the user's disk; it emits this
    so the bound desktop runs ``op`` (read / list / grep / …) against the real
    local directory and posts the structured result back to the ops resolve
    endpoint, keyed by ``request_id``. ``root_id`` names which of the desktop's
    authorized FS roots to operate on (the desktop's own traversal guard then
    keeps ``args`` paths inside it).

    Unlike ``approval_required`` (whose ``arguments`` is a size-bounded *preview*),
    ``args`` is the full op payload — the client must have everything it needs to
    actually perform the op (e.g. the bytes of a write). This event is transport,
    not part of the multi-agent journal, so it is never persisted/replayed.
    """
    return SSEEvent(
        type=EventType.WORKSPACE_OP_REQUIRED,
        payload={
            "request_id": request_id,
            "conversation_id": conversation_id,
            "root_id": root_id,
            "op": op,
            "args": args,
        },
    )


def workspace_promoted(
    *,
    conversation_id: str,
    folder_id: str,
    name: str,
    local_root_id: str | None,
    local_subpath: str,
) -> SSEEvent:
    """A 裸聊 was lazily promoted into a real folder on its first file write.

    A folderless conversation has no workspace until the team first creates a file
    (文件夹即工作区 §懒建); at that moment ``_bare_chat_promote`` mints a folder and
    files the conversation into it. The promotion is server-side and mid-turn, so the
    live client would otherwise not learn of it until a manual refetch — leaving the
    chat stranded in 未分组 and the freshly-written file invisible (no workspace card).
    This event closes that window: the client re-groups the conversation under
    ``folder_id`` and surfaces the new folder in the 文件 rail.

    ``local_root_id`` (+ ``local_subpath``) is set for a **local** promotion (工作区
    对称化 D1a — the file landed on the user's machine under a container root); it is
    ``None`` for a cloud promotion. The client derives local-vs-cloud from its presence
    (mirroring ``FolderMeta``). Emitted once, before the file op itself; not journaled
    (the folder is durable state replayed from the DB on reload).
    """
    return SSEEvent(
        type=EventType.WORKSPACE_PROMOTED,
        payload={
            "conversation_id": conversation_id,
            "folder_id": folder_id,
            "name": name,
            "local_root_id": local_root_id,
            "local_subpath": local_subpath,
        },
    )


def handoff_snapshot_done(
    *, snapshot_id: str, conversation_id: str, size_bytes: int
) -> SSEEvent:
    """A local→云 handoff snapshot (双模式工作区 P2e / e1) completed.

    The bound desktop archived its local workspace over the channel; the server
    staged it and snapshotted it to object storage. Carries the new ``snapshot_id``
    (and its ``size_bytes``) so the client can refresh the snapshot list and
    confirm the backup. Emitted once, just before the handoff SSE closes.
    """
    return SSEEvent(
        type=EventType.HANDOFF_SNAPSHOT_DONE,
        payload={
            "snapshot_id": snapshot_id,
            "conversation_id": conversation_id,
            "size_bytes": size_bytes,
        },
    )


def handoff_job_started(
    *, job_id: str, conversation_id: str, job_conversation_id: str
) -> SSEEvent:
    """A local→云 handoff cloud job (双模式工作区 P2e / e2) was accepted.

    The base snapshot of the user's local files is captured and the team run is
    spawned detached on the server. Carries the ``job_id`` (so the client polls
    its status) and the hidden ``job_conversation_id`` that hosts the team's
    messages / cost / run graph for later replay. Emitted once, just before the
    dispatch SSE closes — the cloud run continues in the background past it.
    """
    return SSEEvent(
        type=EventType.HANDOFF_JOB_STARTED,
        payload={
            "job_id": job_id,
            "conversation_id": conversation_id,
            "job_conversation_id": job_conversation_id,
        },
    )


def handoff_apply_done(
    *, job_id: str, conversation_id: str, results: list[dict[str, Any]]
) -> SSEEvent:
    """A local→云 handoff apply (双模式工作区 P2e / e3) finished writing back.

    The user's selected result changes were replayed onto the local workspace over
    the channel (WRITE_BYTES / DELETE). Carries the per-file ``results`` (each
    ``path`` + ``status`` + ``change_type`` + ``detail``) and the rolled-up counts,
    so the PR card can mark each row done and surface any unresolved conflicts.
    Emitted once, just before the apply SSE closes.
    """
    counts = {"applied": 0, "skipped": 0, "conflict": 0, "error": 0}
    for r in results:
        status = str(r.get("status", ""))
        if status in counts:
            counts[status] += 1
    return SSEEvent(
        type=EventType.HANDOFF_APPLY_DONE,
        payload={
            "job_id": job_id,
            "conversation_id": conversation_id,
            "results": results,
            "applied": counts["applied"],
            "skipped": counts["skipped"],
            "conflicts": counts["conflict"],
            "errors": counts["error"],
        },
    )


def message_end(
    finish_reason: FinishReason,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    reasoning_tokens: int = 0,
    cache_hit_tokens: int = 0,
    cache_miss_tokens: int = 0,
    rounds: int = 0,
    cost: dict[str, Any] | None = None,
) -> SSEEvent:
    """End-of-turn event carrying the turn's total usage + cost (回合总账).

    ``usage`` keeps the long ``*_tokens`` keys (back-compat) and now also carries
    the cache hit/miss split, so the bill can be shown honestly. ``cost`` is the
    turn total ``{input, cached, output, total, currency}`` in integer nano-USD
    (sum of the per-run prices — see ``costing.aggregate_cost``); ``None`` on the
    error / not-found paths where no turn ran.
    """
    return SSEEvent(
        type=EventType.MESSAGE_END,
        payload={
            "finish_reason": finish_reason,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "reasoning_tokens": reasoning_tokens,
                "cache_hit_tokens": cache_hit_tokens,
                "cache_miss_tokens": cache_miss_tokens,
            },
            "cost": cost,
            "rounds": rounds,
        },
    )


def error_event(code: str, message: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.ERROR,
        payload={"code": code, "message": message},
    )


def title_generated(title: str, *, conversation_id: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.TITLE_GENERATED,
        payload={"conversation_id": conversation_id, "title": title},
    )


def turn_saved(*, user_message_id: str) -> SSEEvent:
    """Authoritative id of the just-persisted user message.

    Emitted right after the user turn is written, before the model runs. Lets the
    client swap its optimistic (client-UUID) bubble for the real row id, so
    regenerate / edit target the correct row in-session — and so a retry after a
    mid-stream failure regenerates from the saved turn instead of resending it
    (which would duplicate the user message). Only the user id is needed: every
    in-session action re-runs *from* the user message.
    """
    return SSEEvent(
        type=EventType.TURN_SAVED,
        payload={"user_message_id": user_message_id},
    )


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


def run_started(
    run_id: str,
    agent_id: str,
    *,
    parent_run_id: str | None = None,
    kind: str = "agent",
    revision: int = 0,
) -> SSEEvent:
    """A Run node entered RUNNING.

    ``kind`` is the node type: ``captain`` for the CEO chat-loop root (the turn's
    汇聚点, ``parent_run_id is None``), ``agent`` for a delegated / DAG worker. (No
    arena/debate kind — 多轮辩论 rides an ``agent`` DAG with stance/round tags.)
    ``parent_run_id`` is the delegating run — the CEO
    captain for a top-level worker, the captain worker itself for a 阶段2 nested
    sub-worker — so the graph groups the tree without waiting for the run frame.

    ``revision`` (乙 热修 P4) is the version number of a 定向唤回 续写: ``0`` for an
    ordinary first-time run, ``≥2`` for a revision (the original is v1, so the first
    revision is v2). For a revision ``parent_run_id`` is the ORIGINAL run it
    revises, so the frontend hangs a「修订 vN」child node off it and builds the
    version chain — without this flag a revision is indistinguishable from a 阶段2
    nested sub-worker (which also carries a worker ``parent_run_id``).
    """
    return SSEEvent(
        type=EventType.RUN_STARTED,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "parent_run_id": parent_run_id,
            "kind": kind,
            "revision": revision,
        },
    )


def run_context(run_id: str, agent_id: str, blocks: list[dict[str, Any]]) -> SSEEvent:
    """The structured context a Run received at assembly time (上下文传递可视化).

    ``blocks`` is the ordered, wire-shaped ContextBlock list the executor rendered this
    run's opening user message FROM — the SAME data the LLM was fed (单一源：用户看到的 ==
    LLM 吃到的), each ``{channel, heading, body, chars, truncated, source_role,
    source_run_id, fidelity, files}``. Emitted once per run right after ``run_started`` so
    the frontend's run detail shows exactly what fed it (5 通道之 worker 侧: 原始请求 / 团队
    位置 / 前置结果 / 工作区 / 任务…). Journaled (``_JOURNAL_EVENT_TYPES``) so a past turn
    replays its received context on reload; bodies are head+tail capped at the call site so
    a huge pasted request can't bloat the journal (the cap is flagged via ``truncated``).
    """
    return SSEEvent(
        type=EventType.RUN_CONTEXT,
        payload={"run_id": run_id, "agent_id": agent_id, "blocks": blocks},
    )


def run_output_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    """A delegated worker's output increment — run-scoped, so the team UI streams a
    worker's text into its node/detail live.

    Transport-only liveliness (执行级事件溯源: deltas 退场): NOT in
    ``_JOURNAL_EVENT_TYPES``, so it never enters the journal / fact log. The worker's
    authoritative full output is its ``message_final`` fact (``RunState.content``); a
    reload synthesizes an equivalent delta block from that fact in
    ``journal.runs_from_entries``, so the client fold replays the same output without
    persisting per-token deltas (peer of ``run_tool_progress``).
    """
    return SSEEvent(
        type=EventType.RUN_OUTPUT_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_reasoning_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    """A delegated worker's thinking increment — the reasoning twin of
    ``run_output_delta`` (run-scoped, so the team UI streams a worker's 思考全文 into
    its run-detail live).

    Transport-only liveliness (执行级事件溯源: deltas 退场): NOT journaled. The worker's
    authoritative full thinking is its ``message_final`` fact (``RunState.reasoning``,
    captured by the executor); a reload synthesizes an equivalent reasoning delta block
    from that fact in ``journal.runs_from_entries``, so the thinking still replays
    through the client fold without persisting per-token deltas.
    """
    return SSEEvent(
        type=EventType.RUN_REASONING_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_tool_progress(
    run_id: str, agent_id: str, tool_name: str, chars: int
) -> SSEEvent:
    """A delegated worker is actively composing a tool call's arguments.

    ``chars`` is the cumulative length of the streamed argument string so far (the
    file body for ``file_write``, the query for a search…). The team UI shows
    「正在生成 {tool} · N 字」on the worker's node/detail so a long tool-call
    assembly reads as live progress instead of a frozen node — the bytes surface
    nowhere else (they are neither content nor reasoning, and ``tool_use_start``
    fires only once the args finish). Transport-only (NOT in
    ``_JOURNAL_EVENT_TYPES``): a reloaded run replays the finished call from the
    journaled ``tool_use_start``/``tool_use_end`` instead.
    """
    return SSEEvent(
        type=EventType.RUN_TOOL_PROGRESS,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "tool_name": tool_name,
            "chars": chars,
        },
    )


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
) -> SSEEvent:
    """A Run finished — lights up one team-payroll row live (§七B).

    ``role`` is the cost-ledger category (阶段1 workers are always ``member``);
    ``usage`` is the ledger short-key form (``{input, output, reasoning,
    cache_hit, cache_miss}``) and ``cost`` the priced ``{input, cached, output,
    total, currency}`` (nano-USD). Both default to a zeroed shape (not omitted),
    so the client always gets a full, typed object — a run that never metered the
    LLM simply shows zeros (rendered as「—」, per §七5).
    """
    return SSEEvent(
        type=EventType.RUN_COMPLETED,
        payload={
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
        },
    )


def run_failed(run_id: str, agent_id: str, error: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_FAILED,
        payload={"run_id": run_id, "agent_id": agent_id, "error": error},
    )


def run_progress(completed: int, total: int) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_PROGRESS,
        payload={"completed": completed, "total": total},
    )


def debate_result(
    *,
    execution_id: str,
    moderator_run_id: str,
    payload: dict[str, Any],
) -> SSEEvent:
    """一场辩论收场的完整结构化产物（见 :class:`EventType.DEBATE_RESULT`）。

    ``payload`` 由 ``DebateResult.to_event_payload`` 产出（form / motion / stop_reason /
    rounds / brief / sides），承载交锋叙事线 + 决策简报；各方的发言【全文】不在此（体量大），
    靠 ``rounds[*].sides[*].run_id`` 关联执行图里的辩手节点。``moderator_run_id`` 让前端把
    本事件挂到对应的辩论（主持人节点）上。
    """
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
    """一轮辩论开场（见 :class:`EventType.DEBATE_ROUND_STARTED`）。

    主持人定下本轮焦点后、辩手发言【前】emit，让前端在该轮发言开始流式前先亮出焦点（进行中
    实时叠加）。Transport-only（不进 journal）：收场全量叙事线由 ``debate_result`` 承载。
    """
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
    """一轮辩论收尾（见 :class:`EventType.DEBATE_ROUND`）。

    本轮裁判 + 小结产出【后】emit。``payload`` 由 ``RoundResult.to_event_payload`` 产出
    （round_no / focus / summary / verdict / 各方→辩手 run_id），即 ``debate_result.rounds``
    的逐轮单元——前端进行中据此把本轮焦点 / 小结 / 裁判实时叠到辩论视图。Transport-only
    （不进 journal，重载由 ``debate_result`` 重建）。
    """
    return SSEEvent(
        type=EventType.DEBATE_ROUND,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            **payload,
        },
    )


# Event types that make up the multi-agent execution journal: persisted to the
# turn_journal table (唯一事实源, §18.3) and projected into the assistant message's
# runs payload on read, so a past turn's team graph replays on reload through the
# same client-side fold as the live stream.
_JOURNAL_EVENT_TYPES = frozenset(
    {
        EventType.RUN_PLAN,
        EventType.RUN_STARTED,
        # 收到的上下文 (上下文传递可视化, 决策①进 journal): a run's received ContextBlocks,
        # so a past turn replays exactly what each worker was fed (bodies are capped at the
        # emit site so the journal stays bounded).
        EventType.RUN_CONTEXT,
        # NOTE: run_output_delta / run_reasoning_delta are deliberately NOT here
        # (执行级事件溯源: deltas 退场). They are transport-only liveliness now (peers of
        # run_tool_progress): the worker's authoritative full output + thinking are the
        # ``message_final`` fact, and a reload synthesizes equivalent delta blocks from
        # it via ``journal.runs_from_entries`` — so the client fold is unchanged while
        # the journal stops carrying per-token deltas.
        EventType.RUN_COMPLETED,
        EventType.RUN_FAILED,
        EventType.RUN_PROGRESS,
        # 辩论收场的结构化产物（简报 + 叙事线）：journaled 以便重载原样回放辩论视图——它随
        # 辩论的 run_plan（surface 类型）一起被持久化，runs_from_entries 通用投影即可回放。
        EventType.DEBATE_RESULT,
        EventType.TOOL_USE_START,
        EventType.TOOL_USE_END,
        # User checkpoints (ask_user — opening 引导 or mid-task fork): journaled so
        # the question + answer replay inline on reload, unlike the (transport-only)
        # approval / workspace-op events.
        EventType.CHECKPOINT_REQUIRED,
        EventType.CHECKPOINT_RESOLVED,
        # Non-blocking ask (ask_user blocking=false): journaled so the card replays
        # inline on reload — it has no resolved twin (it never gated the turn).
        EventType.QUESTION_POSTED,
        # Structured DAG checkpoints (checkpoint_after): journaled so the pause +
        # its resolution replay inline on reload, same as ask_user checkpoints.
        EventType.PLAN_REVIEW_REQUIRED,
        EventType.PLAN_REVIEW_RESOLVED,
    }
)

# Event types whose presence alone is enough to persist the journal — a turn that
# never delegated (no run_plan) but did raise a checkpoint still has a journal
# worth replaying. (Tool calls on their own do not: a single-agent turn's own
# tool I/O is not replayed through the team-graph journal — it rides the separate
# process timeline below instead.)
_JOURNAL_SURFACE_TYPES = frozenset(
    {
        EventType.RUN_PLAN.value,
        EventType.CHECKPOINT_REQUIRED.value,
        # A turn that only posted a non-blocking ask (no delegate, no checkpoint) still
        # has a journal worth replaying — its card.
        EventType.QUESTION_POSTED.value,
        EventType.PLAN_REVIEW_REQUIRED.value,
    }
)

# A single tool result can be large (a read_url page, a long grep). The process
# timeline is a display artifact (the inline「思考+工具」面板), not the source of
# truth, so each persisted result is capped — enough for a meaningful preview
# without bloating the message row. The live SSE still carries the full result.
_PROCESS_RESULT_CAP = 8000

# Reconnect replay log (执行与请求解耦 C1 · slice 1b 实时重连续看). A detached run keeps
# emitting; ``_history`` retains a compact, REPLAYABLE transcript of the turn so a
# client that drops (network blip) or reopens (cold) can re-attach, replay what it
# missed, then tail live (see ``EventSink.take_over``). Bounded by VISIBLE content,
# not token count: per-token deltas coalesce (below) and tool results are capped, so
# a long turn's history tracks its rendered size, not its event count.
#
# Skipped — never replayed:
# - Pure liveliness (tool_progress / run_tool_progress): a「正在生成…」counter is
#   moot by reconnect; the finished call replays via tool_use_start/end.
# - Terminal (message_end / error): the live tail delivers the REAL terminal event;
#   a still-running turn (the only kind we attach to) has not emitted one yet.
# - Local/handoff transport (workspace_op_required / handoff_*): replaying an op
#   request would re-run a side-effecting op; these ride their own short SSEs, not
#   the chat-turn attach path.
_HISTORY_SKIP_TYPES = frozenset(
    {
        EventType.TOOL_PROGRESS,
        EventType.RUN_TOOL_PROGRESS,
        EventType.MESSAGE_END,
        EventType.ERROR,
        EventType.WORKSPACE_OP_REQUIRED,
        EventType.HANDOFF_SNAPSHOT_DONE,
        EventType.HANDOFF_JOB_STARTED,
        EventType.HANDOFF_APPLY_DONE,
    }
)
# Turn-scoped deltas coalesce into the trailing same-type history entry (the CEO
# bubble's reply text / thinking), so reconnect replays one content + one reasoning
# block instead of thousands of token events.
_HISTORY_COALESCE_TURN = frozenset(
    {EventType.CONTENT_DELTA, EventType.REASONING_DELTA}
)
# Run-scoped deltas coalesce too, but only into a trailing entry of the SAME run
# (a worker's output / thinking) — interleaved workers keep separate blocks.
_HISTORY_COALESCE_RUN = frozenset(
    {EventType.RUN_OUTPUT_DELTA, EventType.RUN_REASONING_DELTA}
)


class EventSink:
    """Async queue bridging execution (producer) and SSE (consumer).

    Lifecycle events are guaranteed delivery; content deltas can be dropped
    under backpressure (not implemented yet — unbounded queue for MVP).
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[SSEEvent | None] = asyncio.Queue()
        self._closed = False
        # 执行与请求解耦 (C1 · slice 1a): once the SSE consumer goes away (client
        # disconnect) the run keeps going detached, but with no one draining the
        # queue it would grow for the rest of a long turn. ``detach`` flips this so
        # ``emit`` stops queueing transport events while still recording the durable
        # journal / process timeline / fact log (persistence + replay never depended
        # on the consumer). Never un-set — a new turn uses a fresh sink.
        self._detached = False
        # Reconnect replay log (执行与请求解耦 C1 · slice 1b): a compact, coalesced
        # transcript of this turn's REPLAYABLE events, accumulated regardless of
        # detach so a re-attaching client can replay what it missed then tail live
        # (see ``take_over``). Bounded by visible content (deltas coalesced, results
        # capped), independent of the SSE ``_queue`` (which detach stops feeding).
        self._history: list[SSEEvent] = []
        # Ordered run/tool events of this turn (the multi-agent execution
        # journal), accumulated as they are emitted so the team graph can be
        # persisted and replayed. Empty for a pure single-agent turn.
        self._journal: list[dict[str, Any]] = []
        # Single-agent process timeline (前端UX设计.md §一B): the CEO's own thinking,
        # reply text, and tool calls interleaved in emission order, folded into
        # compact segments (consecutive reasoning deltas coalesce into one reasoning
        # step, consecutive content deltas into one content step, one step per tool
        # call). This is the Cursor 式全内联时间线 the client replays for a single-agent
        # turn — the team-graph journal above stays None there. ``_has_run_plan`` marks
        # the turn as multi-agent (graph instead), ``_has_tool`` gates persistence (a
        # tool-less turn replays from reasoning_content + message content, no process
        # payload — there is no interleaving to preserve without tools).
        self._process: list[dict[str, Any]] = []
        self._has_run_plan = False
        self._has_tool = False

    def emit(self, event: SSEEvent) -> None:
        if not self._closed:
            if event.type in _JOURNAL_EVENT_TYPES:
                self._journal.append(
                    {
                        "type": event.type.value,
                        "payload": event.payload,
                        "timestamp": event.timestamp,
                    }
                )
                # 执行级事件溯源: forward this display fact into the turn's single
                # ordered fact log (§18.3), interleaved with the engine's execution
                # facts (llm_call / round_boundary / …). The log is the durable
                # journal's source; this keeps the display lane (above) and the
                # execution lane in ONE order. No-op outside a turn (no log bound).
                record_turn_fact(
                    Fact(
                        kind=event.type.value,
                        payload=event.payload,
                        ts=event.timestamp,
                    )
                )
            self._accumulate_process(event)
            # Reconnect transcript (slice 1b): accumulated even while detached so a
            # later attach can replay it — independent of the SSE queue below.
            self._record_history(event)
            # After ``detach`` (consumer gone, run continues) skip the SSE queue so
            # it cannot grow unbounded — the journal/process/fact accumulation above
            # already ran, so the turn still persists + replays in full.
            if not self._detached:
                self._queue.put_nowait(event)

    def _record_history(self, event: SSEEvent) -> None:
        """Fold one event into the bounded reconnect replay log (slice 1b).

        Mirrors what the live SSE consumer would have applied, minus the noise:
        liveliness / terminal / local-op events are skipped (see
        ``_HISTORY_SKIP_TYPES``), per-token deltas coalesce into the trailing
        same-stream block, and a tool result is capped. The result is a compact
        transcript that, replayed through the SAME client dispatch, reconstructs the
        turn's on-screen state up to now — then the live tail continues it.
        """
        t = event.type
        if t in _HISTORY_SKIP_TYPES:
            return
        if t in _HISTORY_COALESCE_TURN:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            last = self._history[-1] if self._history else None
            if last is not None and last.type == t:
                last.payload["delta"] = (last.payload.get("delta") or "") + delta
            else:
                self._history.append(
                    SSEEvent(type=t, payload={"delta": delta}, timestamp=event.timestamp)
                )
            return
        if t in _HISTORY_COALESCE_RUN:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            run_id = event.payload.get("run_id")
            last = self._history[-1] if self._history else None
            if (
                last is not None
                and last.type == t
                and last.payload.get("run_id") == run_id
            ):
                last.payload["delta"] = (last.payload.get("delta") or "") + delta
            else:
                self._history.append(
                    SSEEvent(type=t, payload=dict(event.payload), timestamp=event.timestamp)
                )
            return
        if t == EventType.TOOL_USE_END:
            payload = dict(event.payload)
            result = payload.get("result")
            if isinstance(result, str) and len(result) > _PROCESS_RESULT_CAP:
                payload["result"] = result[:_PROCESS_RESULT_CAP] + "…"
            self._history.append(
                SSEEvent(type=t, payload=payload, timestamp=event.timestamp)
            )
            return
        self._history.append(
            SSEEvent(type=t, payload=event.payload, timestamp=event.timestamp)
        )

    def detach(self) -> None:
        """Stop queueing transport events after the SSE consumer disconnects (断连续跑).

        Called by the SSE layer when the client drops mid-turn under
        ``detach_on_disconnect`` (执行与请求解耦 C1 · slice 1a): the detached run
        keeps executing and persisting, but nothing is draining ``_queue`` anymore,
        so further ``emit`` calls would pile up for the rest of the turn. After this,
        ``emit`` still records the journal, single-agent process timeline, and fact
        log (those are independent of delivery), it just no longer enqueues for SSE.
        Idempotent; never reversed by the disconnect path (a fresh turn gets a fresh
        sink) — only a deliberate re-attach (``take_over``) re-enables the queue.
        """
        self._detached = True

    def take_over(self) -> list[SSEEvent]:
        """Hand a re-attaching consumer the replay transcript and resume live tailing.

        实时重连续看 (执行与请求解耦 C1 · slice 1b). A client that dropped (or a fresh
        one reopening the conversation) attaches to the still-running detached run via
        this. Runs synchronously (no ``await``) so it is atomic against ``emit``:

        1. Drain + discard the unread SSE backlog — every one of those events is
           already represented in ``_history`` (emit records history BEFORE the
           queue), so keeping them would double them against the replay.
        2. Snapshot ``_history`` — the events to replay (everything up to now).
        3. Re-enable the queue (un-detach) IF the run is still live, so post-snapshot
           ``emit`` calls tail to this new consumer. If the run already finished
           (raced us between registry lookup and here), re-arm the close sentinel
           instead so the consumer replays then ends cleanly.

        The caller yields the returned snapshot, then drains ``get()`` for the tail.
        """
        while True:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        snapshot = list(self._history)
        if self._closed:
            self._queue.put_nowait(None)
        else:
            self._detached = False
        return snapshot

    def _accumulate_process(self, event: SSEEvent) -> None:
        """Fold one event into the single-agent process timeline.

        Mirrors the client-side build (streamConversation) so a live turn and its
        reloaded twin produce the same inline timeline (前端UX设计.md §一B): reasoning
        deltas coalesce into the trailing reasoning step, content deltas into the
        trailing content step (the CEO's reply text, interleaved in true emission
        order — the trailing content step is the final answer), and each tool call
        appends a step that its matching ``tool_use_end`` later resolves (result +
        status). Events arrive here in emission order, so the steps are ordered.
        """
        t = event.type
        if t == EventType.RUN_PLAN:
            self._has_run_plan = True
        elif t == EventType.REASONING_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            if self._process and self._process[-1].get("kind") == "reasoning":
                self._process[-1]["text"] += delta
            else:
                self._process.append({"kind": "reasoning", "text": delta})
        elif t == EventType.CONTENT_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            if self._process and self._process[-1].get("kind") == "content":
                self._process[-1]["text"] += delta
            else:
                self._process.append({"kind": "content", "text": delta})
        elif t == EventType.CONTENT_RESET:
            # 交付前核验回炉：丢弃刚累积的这一版正文（含违规引用），让重写版从干净状态重新
            # 累积。只弹尾部连续的 content step——其前的 reasoning / tool step 是真实发生过
            # 的过程，保留。镜像客户端对 content_reset 的处理，使实时与回放一致。
            while self._process and self._process[-1].get("kind") == "content":
                self._process.pop()
        elif t == EventType.TOOL_USE_START:
            self._has_tool = True
            payload = event.payload
            self._process.append(
                {
                    "kind": "tool",
                    "id": payload.get("tool_call_id", ""),
                    "tool_name": payload.get("tool_name", ""),
                    "arguments": payload.get("arguments") or {},
                    "result": None,
                    "status": "running",
                }
            )
        elif t == EventType.TOOL_USE_END:
            payload = event.payload
            call_id = payload.get("tool_call_id", "")
            result = payload.get("result")
            if isinstance(result, str) and len(result) > _PROCESS_RESULT_CAP:
                result = result[:_PROCESS_RESULT_CAP] + "…"
            # The structured display (工具结果富渲染) is already size-capped by the
            # event builder, so it persists onto the step as-is for the client to
            # render the rich result on reload (alongside the text result peek).
            display = payload.get("display")
            for step in reversed(self._process):
                if step.get("kind") == "tool" and step.get("id") == call_id:
                    step["result"] = result
                    step["status"] = payload.get("status", "success")
                    if display is not None:
                        step["display"] = display
                    break

    def seed_journal(self, events: list[dict[str, Any]]) -> None:
        """Pre-load the journal with a paused turn's pre-pause events (结构化挂起 2b resume).

        A resumed turn runs on a FRESH sink, but its persisted journal (turn_journal,
        projected as the message's runs payload) must replay the WHOLE team graph —
        the pre-pause run_plan + finished workers + the
        plan_review pause, then the post-resume tail. Seeding extends only the journal
        (persistence/replay), NOT the live SSE queue: the client already saw the
        pre-pause portion (or loads it from the persisted message), so the resume
        stream carries only new events. A re-pause during resume then captures the
        cumulative journal naturally.
        """
        self._journal.extend(events)

    def execution_journal(self) -> list[dict[str, Any]] | None:
        """This turn's ordered run/tool events, or None if there is nothing to replay.

        Returns None unless the turn either delegated (``run_plan``) or raised a
        checkpoint (``checkpoint_required``) — a plain single-agent turn (whose
        only journalled events would be the CEO's own tool calls) persists no runs
        payload, but a single-agent turn that paused to ask the user does (so the
        exchange replays).
        """
        has_surface = any(
            e["type"] in _JOURNAL_SURFACE_TYPES for e in self._journal
        )
        return self._journal if has_surface else None

    def process_timeline(self) -> list[dict[str, Any]] | None:
        """This single-agent turn's「思考·正文·工具」inline timeline, or None.

        None for a multi-agent turn (``run_plan`` → the team graph carries the
        activity instead) or a turn that used no tool: a tool-less turn has no
        interleaving to preserve (reasoning always precedes the reply), so it
        replays from ``reasoning_content`` (one thinking segment) + the message
        content (the answer) — no process payload needed. Otherwise the ordered
        reasoning/content/tool steps the client folds into the inline timeline,
        persisted via the journal (projected as the message's ``runs.process``);
        the trailing content step is the final answer.
        """
        if self._has_run_plan or not self._has_tool:
            return None
        return self._process or None

    def close(self) -> None:
        """Signal end-of-stream to consumer."""
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(None)

    async def get(self) -> "SSEEvent | None":
        """Pull the next event, or ``None`` once the stream is closed.

        The SSE layer consumes via this (not ``__aiter__``) so it can race the
        pull against a heartbeat timeout — a slow turn keeps the connection warm
        with keep-alive frames instead of looking dead to the client.
        """
        return await self._queue.get()

    async def __aiter__(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event
