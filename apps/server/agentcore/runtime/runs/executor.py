"""Host-side AGENT run executor: run one RunSpec node via the shared ReAct loop.

This is the host wiring the pure :class:`WaveScheduler` drives. Given a node's
spec and the terminal states of its dependencies, it builds the worker's messages
(role/objective system prompt + original request + upstream dep products + the
node's task), runs ``engine.react_loop``, and folds the result into a
:class:`RunState` (with this node's token usage). It mirrors the old
``runs.run_one`` but as an injectable :class:`RunExecutor`, so scheduling and
execution are decoupled.

Event emission stays here (the host's concern): ``run_started`` /
``run_output_delta`` / ``run_completed`` / ``run_failed`` light up the graph in
real time, exactly as the legacy path did.

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import asdict, replace

from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.llm.config import ModelProfile, apply_overrides
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    run_completed,
    run_failed,
    run_output_delta,
    run_reasoning_delta,
    run_started,
    run_tool_progress,
    tool_progress,
)
from agentcore.runtime.facts import MessageFinalFact, record_turn_fact
from agentcore.runtime.runs.serialize import run_final_fact
from agentcore.runtime.runs.constants import (
    DEFAULT_CONTRACT_RETRIES,
    DEP_CONTEXT_BUDGET,
    DEP_POINTER_MAX_FILES,
    DEP_POINTER_SUMMARY_CHARS,
    DEP_SUMMARY_CHARS,
    ESCALATE_TOOL_NAME,
    MAX_CONTRACT_RETRIES,
    MAX_DELEGATION_DEPTH,
    WORKSPACE_MANIFEST_CHAR_BUDGET,
    WORKSPACE_MANIFEST_MAX_FILES,
)
from agentcore.runtime.runs.contract import (
    ContractVerdict,
    check_contract,
    describe_contract,
    format_feedback,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import RunExecutor
from agentcore.runtime.runs.serialize import (
    escalations_from_transcript,
    files_touched_from_transcript,
)
from agentcore.runtime.runs.session import RunSession
from agentcore.runtime.runs.types import RunContract, RunPhase, RunSpec, RunState
from agentcore.runtime.suspension import captain_transcript
from agentcore.runtime.workspace import summarize
from agentcore.tools.protocol import Tool, ToolContext
from agentcore.tools.registry import ToolRegistry

# A worker's nested-delegate factory: given (captain_run_id, captain_depth) — the
# worker's own run id + depth — it mints a ``delegate`` tool bound to that worker
# as the sub-team's captain. Owned by the DelegateTool (which can import the tools
# package), passed in here so ``runs`` stays free of a tools dependency.
DelegateFactory = Callable[[str, int], Tool]

logger = get_logger(__name__)

# The deliverable-form policy shared by every delegated worker (leaf + captain).
# It is the hinge that decides whether a product is PROSE (written as the text
# answer) or a FILE ARTIFACT (persisted to the workspace via file_write). The
# earlier identity only said "your text output is shown to the user", which steered
# workers to PASTE file deliverables — runnable code, whole HTML apps, docs — inline
# as one giant chat message and call no tools, so a "build a runnable HTML file"
# task produced a 46k-char reply and ZERO files on disk (nothing for the user to
# open / run, and nothing the workspace snapshot / FileBrowser could surface). The
# split is stated explicitly so a file deliverable actually lands in the workspace.
_WORKER_DELIVERABLE_POLICY = """\
分清你的交付【形态】，用对的方式交付：
- 交付物是【可独立阅读的文字】（分析、审查意见、设计 / 调研说明、解释、问答）时，直接\
作为你的文字产出写出来，自包含、完整准确。
- 交付物是【文件 / 产物】（可运行代码 / 网页 / 应用、脚本、配置、数据文件、多文件工程，\
或任何用户要打开 / 运行 / 编辑 / 保存的东西，或任务要求「产出文件」）时，你【必须】调用 \
file_write 把它真正写进工作区，而不是把整份内容粘在回复正文里；此时正文只简短交代：改了\
哪些文件（给路径）、怎么运行、关键取舍，不要再整份粘贴文件内容。只贴在聊天里的代码不算交付。

直接以产出本身开头，别写「我来为你生成…」「我是一个 agent」之类开场白或元叙述。你的文字\
产出会直接展示给用户、也回流给主 Agent 整合，故要完整、准确、可独立阅读；任务附带产出\
要求就逐条满足。

这份交付物的【专业结构】由你这位专家定夺：task 或预期产出里若带了章节 / 模块 / 布局骨架，\
除非【原始用户请求】中用户亲口指定要照此结构，否则只当起点建议——按你的专业判断去重组、\
增删、优化，而不是照它填字。硬指标（篇幅 / 格式 / 范围 / 受众 / 必含要点 / 验收项）仍须\
逐条满足；但「这份交付物怎么搭骨架、怎么展开」正是你最核心的专业产出。"""

# Prepended to every delegated worker's system prompt (right after the shared
# base). A leaf worker runs in an isolated context with one scoped task, no chance
# to ask follow-ups, and no `delegate` tool — stated explicitly so it makes a
# reasonable assumption and delivers, instead of punting with a clarifying
# question it can never get answered. The shared deliverable policy then pins
# prose-vs-file so a file deliverable lands in the workspace, not in the chat.
_WORKER_IDENTITY = f"""\
你是团队中的一名专家 worker。你只负责一个划定好的任务，外加完成它所需的上下文；\
你不能再向下委派。信息不足时，默认做出最合理的假设、简短说明，然后照常交付最佳结果——\
不要为小事停下。只有遇到【必须由上级拍板的关键岔路】或【缺了就会让整件事走偏的信息】时，\
才调用 escalate 把这个待决问题上报给主管（你够不到用户，这是你唯一的向上通道）；escalate \
不会打断你、也不是停工——上报后仍按你当下最合理的假设把任务做完，主管会在你的产物之上纠偏。

{_WORKER_DELIVERABLE_POLICY}"""

# Variant identity for a worker that opted into one nested delegation level
# (``can_delegate`` and still above the depth cap). Unlike the leaf worker it MAY
# call ``delegate`` once to split its task across a small sub-team it commands —
# but only when the work genuinely needs it, and its own sub-workers cannot
# delegate further (the executor withholds the tool from them). Same deliverable
# policy: whatever it ultimately produces follows the prose-vs-file split.
_WORKER_CAPTAIN_IDENTITY = f"""\
你是团队中的一名专家 worker，并且被额外授权可以再向下委派一层子团队。你负责一个划定\
好的任务，外加完成它所需的上下文；你够不到用户、不会有人实时答疑。如果这个任务复杂到需要进一步\
拆分，你可以调用 delegate 把它拆给一支由你指挥的子团队（只能再嵌套这一层，你的子成员\
不能再向下委派），看到他们的产出后由你整合；若任务并不需要拆分，就自己直接完成，不要\
为委派而委派。信息不足时做出最合理的假设、简短说明，然后照常交付；只有遇到必须由上级\
拍板的关键岔路，才用 escalate 上报给主管（你够不到用户），上报后仍按假设照常把活做完。

{_WORKER_DELIVERABLE_POLICY}"""


def build_agent_executor(
    *,
    plan: RunPlan,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    profile_set: ProfileSet | None = None,
    system_prompt: str,
    user_message: str,
    execution_id: str,
    approval_gate: ApprovalGate | None = None,
    delegate_factory: DelegateFactory | None = None,
) -> RunExecutor:
    """Build a :class:`RunExecutor` bound to one turn's wiring.

    Closes over ``plan`` so a node can resolve a dependency's display role when
    labelling injected upstream context; the scheduler passes only the terminal
    ``completed`` states per call.

    ``profile_set`` is the turn's resolved 质量档 (llm/modes.py): a worker's tier
    (fast/strong) is mapped to its model through it, so the user's selection reaches
    every delegated worker.

    ``approval_gate`` gates this team's GRANTABLE tool calls (``code_execute`` /
    ``file_write`` / ``str_replace``). It is the *same* per-turn gate the CEO uses,
    passed only in **local mode** (双模式工作区 P2d 执行门) so a delegated worker
    can never run code or mutate files on the user's real machine without consent;
    in cloud mode it is ``None`` (workers stay un-gated — the server sandbox is
    isolated). A shared gate means one "allow for the rest of this turn" covers the
    whole team.

    ``delegate_factory`` (when given) enables one nested delegation level (阶段2
    嵌套子任务): a worker that opted in (``spec.can_delegate``) and is still above
    the depth cap (``spec.depth < MAX_DELEGATION_DEPTH``) is handed its OWN
    ``delegate`` tool, bound to itself as the sub-team's captain. Leaf workers and
    depth-capped workers never receive it, so the tree can never nest past
    CEO → worker → sub-worker.
    """
    # None (standalone / tests) = the economy base set; production passes the
    # turn's resolved 质量档 from the delegate tool.
    profiles = profile_set or default_profile_set()

    # Per-turn snapshot of the workspace's PRE-EXISTING files (uploads / prior turns),
    # shared by every worker in this delegate batch. "What was already on disk when the
    # team started" doesn't change within the turn, so walk it ONCE (newest-first,
    # ``order="recent"``) instead of re-walking + re-stat-ing per worker — the cost the
    # mtime sort would otherwise multiply across a wave. Teammate products stay FRESH per
    # worker (from the completion map), so a later wave still sees earlier waves' landed
    # files via their ``files_touched``. Lazy + lock so concurrent wave-1 workers trigger
    # exactly one walk; best-effort (:func:`_safe_index_files` swallows failures → []).
    # Trade-off: a file a teammate wrote INDIRECTLY (code_execute side effect, not in
    # ``files_touched``) won't appear in a later wave's manifest — acceptable; the common
    # cases (uploads / prior turns / file_write products) are fully covered.
    _ambient_snapshot: dict[str, list[str]] = {}
    _ambient_lock = asyncio.Lock()

    async def _preexisting_files() -> list[str]:
        if "paths" in _ambient_snapshot:
            return _ambient_snapshot["paths"]
        async with _ambient_lock:
            if "paths" not in _ambient_snapshot:  # double-check after awaiting the lock
                _ambient_snapshot["paths"] = await _safe_index_files(
                    base_tool_context.backend
                )
            return _ambient_snapshot["paths"]

    async def _execute_node(
        spec: RunSpec, completed: Mapping[str, RunState], agent_id: str
    ) -> RunState:
        sink.emit(
            run_started(
                spec.run_id,
                agent_id,
                parent_run_id=spec.parent_run_id,
                kind=spec.kind,
            )
        )
        start = time.monotonic()
        contract = spec.policy.contract
        # Hoisted out of the try so a hard exception can still bill what this run
        # already spent (B-deep 失败计费): ``run_usage``/``run_rounds`` accumulate the
        # completed contract-retry attempts, ``inflight`` mirrors the in-flight pass's
        # spend (filled by react_loop, read only if that pass raises), and
        # ``priced_model`` is the tier to price against once the profile resolves
        # (None before that → an early setup failure carries no usage to price).
        run_usage = TokenUsage()
        run_rounds = 0
        inflight: list[TokenUsage] = []
        priced_model: str | None = None
        try:
            profile = apply_overrides(
                profiles.agent(spec.model_preference),
                thinking=spec.thinking,
                reasoning_effort=spec.reasoning_effort,
            )
            priced_model = profile.model
            tool_ctx = replace(
                base_tool_context,
                run_id=spec.run_id,
                agent_id=agent_id,
                execution_id=execution_id,
            )
            # 阶段2 嵌套子任务: hand this worker its own delegate tool only when it
            # opted in and is still above the depth cap — then it leads a sub-team
            # (one extra level) and is told so via the captain identity. Otherwise
            # it is a leaf worker on the shared registry with no delegate.
            worker_tools = tools
            # spec.tools is None for an unrestricted worker → react_loop offers all
            # team tools (the fail-safe default); a non-empty list restricts to those.
            allowed_tools = spec.tools
            identity = _WORKER_IDENTITY
            if (
                delegate_factory is not None
                and spec.can_delegate
                and spec.depth < MAX_DELEGATION_DEPTH
            ):
                child_delegate = delegate_factory(spec.run_id, spec.depth)
                worker_tools = _registry_with(tools, child_delegate)
                # Unrestricted (None) stays None — the delegate now lives in
                # worker_tools, so "offer all" already includes it. A restricted list
                # must explicitly gain the delegate name to keep it callable.
                allowed_tools = (
                    None
                    if spec.tools is None
                    else [*spec.tools, child_delegate.schema.name]
                )
                identity = _WORKER_CAPTAIN_IDENTITY
            # escalate is a worker's always-available upward channel — a safety primitive,
            # not a capability the CEO restricts away. An unrestricted worker (None) is
            # already offered it; a least-privilege worker (non-empty allow-list) must
            # keep it explicitly, so it can still flag a blocker instead of guessing.
            if allowed_tools is not None and ESCALATE_TOOL_NAME not in allowed_tools:
                allowed_tools = [*allowed_tools, ESCALATE_TOOL_NAME]
            # Produce → check contract → re-prompt with the specific shortfalls.
            # This content-quality retry is intentionally separate from the
            # scheduler's infra-failure retry (RunPolicy.on_failure): they answer
            # different questions and must not be conflated.
            content = ""
            verdict = ContractVerdict(ok=True)
            # Web sources this worker consults, de-duped across contract retries.
            # Collect-only (annotate_citations=False): the worker text stays
            # un-numbered; the DelegateTool folds these into the turn's shared
            # source card so the user sees the WHOLE team's research, not just the
            # CEO's own searches.
            worker_citations: list[dict] = []
            # Pre-existing workspace files (uploads / prior turns) for the worker's
            # opening manifest — a per-turn snapshot walked once and shared by the whole
            # batch (see ``_preexisting_files``); peer products are layered on per worker
            # from the completion map inside ``_build_messages``.
            index_paths = await _preexisting_files()
            # Build the worker's opening (system + task) ONCE; auto-rework then
            # CONTINUES on this SAME transcript (append the shortfall, re-run)
            # instead of rebuilding from scratch — so the worker sees its own prior
            # draft when correcting (修隐患), and the finished transcript is captured
            # as a recoverable RunSession for 定向唤回 (统一「续写」原语, 见 §三).
            messages = _build_messages(
                plan,
                spec,
                completed,
                system_prompt,
                user_message,
                contract,
                identity=identity,
                index_paths=index_paths,
            )
            attempts = 1 + min(DEFAULT_CONTRACT_RETRIES, MAX_CONTRACT_RETRIES)
            for attempt in range(attempts):
                content, round_usage, round_rounds = await _react_and_capture(
                    messages,
                    llm=llm,
                    tools=worker_tools,
                    sink=sink,
                    tool_ctx=tool_ctx,
                    profile=profile,
                    allowed_tools=allowed_tools,
                    run_id=spec.run_id,
                    agent_id=agent_id,
                    citation_sink=worker_citations,
                    approval_gate=approval_gate,
                    usage_sink=inflight,
                )
                run_usage = run_usage + round_usage
                run_rounds += round_rounds
                # This pass's usage is now folded into run_usage via its return value;
                # drop the mirror so a later non-react raise can't double-count it.
                inflight.clear()
                # files_written backs the contract's requires_files gate: derived
                # from this transcript's file-tool calls so a file deliverable that
                # was only pasted into the reply (never written) fails and reworks.
                verdict = check_contract(
                    content,
                    contract,
                    files_written=len(files_touched_from_transcript(messages)),
                )
                if verdict.ok or attempt == attempts - 1:
                    break
                messages.append(_retry_message(format_feedback(verdict)))
                logger.info(
                    "contract.retry",
                    run_id=spec.run_id,
                    attempt=attempt + 1,
                    failures=verdict.failures,
                )

            duration_ms = int((time.monotonic() - start) * 1000)
            # Price this run once (the only place a worker's cost is computed),
            # carried on the state so the per-run ledger and UI payroll read it
            # without re-pricing. Cost is recorded even on FAILED so a stopped
            # run still shows what it已花费.
            usage = run_usage.as_dict()
            cost = asdict(calculate_cost(profile.model, run_usage))
            # Upward escalations this worker raised (escalate tool calls), harvested
            # once from the transcript and carried on BOTH terminal states — a worker
            # that flags a blocker then fails its contract should still surface that
            # blocker to the CEO.
            escalations = escalations_from_transcript(messages)
            if not verdict.ok and _is_hard_failure(content, contract):
                reason = "；".join(verdict.failures)
                logger.info("contract.failed", run_id=spec.run_id, failures=verdict.failures)
                sink.emit(run_failed(spec.run_id, agent_id, reason))
                return RunState(
                    phase=RunPhase.FAILED,
                    content=content,
                    error=reason,
                    escalations=escalations,
                    citations=worker_citations,
                    model=profile.model,
                    duration_ms=duration_ms,
                    rounds=run_rounds,
                    usage=usage,
                    cost=cost,
                    transcript=messages,
                )
            # The worker's terminal RunState is journaled at the ``execute`` choke point
            # below (run_final_fact — covers COMPLETED *and* FAILED in one place), so resume
            # re-seeds it from facts not the旁路 frame (执行级事件溯源 Phase 2 ⑥).
            sink.emit(
                run_completed(
                    spec.run_id,
                    agent_id,
                    output_summary=summarize(content),
                    duration_ms=duration_ms,
                    # 阶段1 scheduled runs are all delegated workers → member row;
                    # the already-priced usage/cost light up the payroll live.
                    role="member",
                    model=profile.model,
                    usage=usage,
                    cost=cost,
                )
            )
            return RunState(
                phase=RunPhase.COMPLETED,
                content=content,
                warnings=[] if verdict.ok else list(verdict.failures),
                escalations=escalations,
                citations=worker_citations,
                model=profile.model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                files_touched=files_touched_from_transcript(messages),
                usage=usage,
                cost=cost,
                transcript=messages,
            )
        except Exception as e:  # noqa: BLE001 — surface any run failure to UI/state
            duration_ms = int((time.monotonic() - start) * 1000)
            # Bill the rounds that completed before the failure: finished attempts are
            # already in run_usage; an in-flight pass that raised left its spend in
            # ``inflight`` (B-deep 失败计费).
            if inflight:
                run_usage = run_usage + inflight[0]
            logger.error("run.failed", run_id=spec.run_id, error=str(e), exc_info=True)
            sink.emit(run_failed(spec.run_id, agent_id, str(e)))
            return _priced_failure(
                str(e),
                model=priced_model,
                usage=run_usage,
                rounds=run_rounds,
                duration_ms=duration_ms,
            )

    async def execute(spec: RunSpec, completed: Mapping[str, RunState]) -> RunState:
        # Bind this worker's identity so EVERY log emitted under it (tool.execute_end,
        # contract.*, run.*, llm.*, react_loop internals) carries run_id/agent_id/
        # depth — analysis can then split tool quality + events by worker. The scope
        # auto-clears on exit; contextvars are task-local, so concurrent workers in a
        # wave never bleed identities into one another.
        agent_id = spec.agent_id or spec.run_id
        with log_context(run_id=spec.run_id, agent_id=agent_id, depth=spec.depth):
            state = await _execute_node(spec, completed, agent_id)
            # 执行级事件溯源 Phase 2 ⑥: journal the worker's terminal RunState (the seed shape)
            # at the SINGLE run choke point — every phase (COMPLETED / FAILED) covered once —
            # so a resume re-seeds finished nodes from facts (completed_from_journal), not the
            # 旁路 ``frame.completed``. The heavy transcript is dropped by ``state_to_json``.
            record_turn_fact(run_final_fact(spec.run_id, state))
            return state

    return execute


def build_captain_executor(
    *,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    chat_system_prompt: str,
    history: list[dict],
    user_message: str,
    profile: ModelProfile,
    citation_sink: list[dict],
    approval_gate: ApprovalGate | None = None,
) -> Callable[[RunSpec], Awaitable[RunState]]:
    """Build the executor for the turn's CAPTAIN root run — the CEO chat loop.

    The captain is the turn's root Run node: unlike a delegated worker it owns the
    conversation voice (its content/reasoning stream to the chat bubble via the
    engine's default ``content_delta`` / ``reasoning_delta``, NOT run-scoped), runs
    the ``chat`` profile, holds the read/retrieval tools + ``delegate``, and writes
    the user-facing reply (possibly after delegating). It shares the one
    ``react_loop`` assembly with workers; only the message build + output routing +
    cost role differ. It runs directly (not via the WaveScheduler — it is the root
    that *calls* delegate, which schedules the children), so it takes no
    ``completed`` deps map.

    The captain's run lifecycle (``run_started`` / ``run_completed`` role=captain)
    is emitted so the graph has a real root 汇聚点 (declared in the delegate batch's
    ``run_plan``); a non-delegating turn emits them too but, lacking a ``run_plan``,
    they are dropped client-side and never journaled into a graph. Priced once here
    (``state.cost``) so the captain payroll row shows real cost; the pipeline reads
    that into the captain ledger row (no re-price).
    """

    async def execute(spec: RunSpec) -> RunState:
        tool_ctx = replace(
            base_tool_context, run_id=spec.run_id, agent_id=spec.agent_id or spec.run_id
        )
        messages = [LLMMessage(role="system", content=chat_system_prompt)]
        for msg in history:
            messages.append(LLMMessage(role=msg["role"], content=msg["content"]))
        messages.append(LLMMessage(role="user", content=user_message))
        return await _drive_captain_loop(
            spec=spec,
            messages=messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_ctx=tool_ctx,
            profile=profile,
            citation_sink=citation_sink,
            approval_gate=approval_gate,
        )

    return execute


def build_captain_resumer(
    *,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    profile: ModelProfile,
    citation_sink: list[dict],
    approval_gate: ApprovalGate | None = None,
) -> Callable[[RunSpec, list[LLMMessage]], Awaitable[RunState]]:
    """Build the captain executor for a RESUMED turn (结构化挂起 2b).

    Same loop as :func:`build_captain_executor`, but the CEO transcript is REBUILT by
    the caller (the stored pre-pause messages + the resumed ``delegate`` tool result)
    and handed in, instead of assembled from system/history/user. The CEO continues
    from exactly where it suspended — reading the workers' product as the delegate
    tool result and writing its overview (or delegating again). Emits the captain
    ``run_*`` lifecycle so the resumed turn's graph has its root 汇聚点 like a normal
    turn; the client dedupes the captain node by id across the original + resumed
    journal segments.
    """

    async def execute(spec: RunSpec, messages: list[LLMMessage]) -> RunState:
        tool_ctx = replace(
            base_tool_context, run_id=spec.run_id, agent_id=spec.agent_id or spec.run_id
        )
        return await _drive_captain_loop(
            spec=spec,
            messages=messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_ctx=tool_ctx,
            profile=profile,
            citation_sink=citation_sink,
            approval_gate=approval_gate,
        )

    return execute


async def _drive_captain_loop(
    *,
    spec: RunSpec,
    messages: list[LLMMessage],
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_ctx: ToolContext,
    profile: ModelProfile,
    citation_sink: list[dict],
    approval_gate: ApprovalGate | None,
) -> RunState:
    """Run the CEO captain ReAct loop over ``messages`` and fold it into a RunState.

    Shared by the first-time captain executor and the resume captain executor: emits
    the captain ``run_started`` / ``run_completed`` (role=captain), prices the run
    once, and PUBLISHES the live ``messages`` list on :data:`captain_transcript` for
    the duration of the loop — so the ``delegate`` checkpoint hook, running deep inside
    this same task, can snapshot the CEO transcript when it captures a durable
    suspension frame (结构化挂起 2b). The contextvar is task-local and reset on exit,
    so concurrent turns never see each other's transcript.
    """
    agent_id = spec.agent_id or spec.run_id
    sink.emit(run_started(spec.run_id, agent_id, parent_run_id=None, kind=spec.kind))
    start = time.monotonic()
    token = captain_transcript.set(messages)
    # Mirrors the loop's cumulative spend so a hard captain failure still bills the
    # rounds that completed (B-deep 失败计费). NB: the captain runs raise_on_error=False,
    # so an LLM error RETURNS partial usage (priced on the COMPLETED path below); this
    # except only catches non-LLM crashes, where the mirror is the only record left.
    inflight: list[TokenUsage] = []
    # B2: react_loop appends a FinishReason here when the captain loop ends on a
    # non-default terminal path (DEGRADED — empty responses even after the fallback
    # retry; or UNPRODUCTIVE — early-stopped on all-tools-failed-no-content rounds),
    # so the turn finishes on that reason instead of END_TURN.
    finish_override: list[FinishReason] = []
    try:
        content, reasoning, usage, rounds = await react_loop(
            messages=messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_context=tool_ctx,
            profile=profile,
            # The captain's content/reasoning stream to the bubble (engine defaults);
            # its tool-call ARGUMENT assembly (the big delegate 任务书, composed before
            # run_plan exists) rides a bubble-scoped tool_progress so it isn't invisible.
            on_tool_progress=lambda tool, chars: sink.emit(tool_progress(tool, chars)),
            citation_sink=citation_sink,
            annotate_citations=True,
            approval_gate=approval_gate,
            usage_sink=inflight,
            finish_override_sink=finish_override,
            run_id=spec.run_id,
            role="captain",
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        usage_dict = usage.as_dict()
        cost = asdict(calculate_cost(profile.model, usage))
        # 执行级事件溯源 (§18.3): the captain's FULL reply (vs the run_completed
        # summary) so the turn's reply is reconstructable from the journal alone.
        record_turn_fact(
            MessageFinalFact(
                run_id=spec.run_id, content=content, reasoning=reasoning
            ).to_fact()
        )
        sink.emit(
            run_completed(
                spec.run_id,
                agent_id,
                output_summary=summarize(content),
                duration_ms=duration_ms,
                role="captain",
                model=profile.model,
                usage=usage_dict,
                cost=cost,
            )
        )
        return RunState(
            phase=RunPhase.COMPLETED,
            content=content,
            reasoning=reasoning,
            model=profile.model,
            duration_ms=duration_ms,
            rounds=rounds,
            usage=usage_dict,
            cost=cost,
            finish_override=finish_override[0] if finish_override else None,
        )
    except Exception as e:  # noqa: BLE001 — surface any captain failure to UI/state
        duration_ms = int((time.monotonic() - start) * 1000)
        partial = inflight[0] if inflight else TokenUsage()
        logger.error("run.captain_failed", run_id=spec.run_id, error=str(e), exc_info=True)
        sink.emit(run_failed(spec.run_id, agent_id, str(e)))
        return _priced_failure(
            str(e),
            model=profile.model,
            usage=partial,
            rounds=0,
            duration_ms=duration_ms,
        )
    finally:
        captain_transcript.reset(token)


def _registry_with(base: ToolRegistry, extra: Tool) -> ToolRegistry:
    """A per-worker registry = the shared team tools + one extra tool (its nested
    delegate). Returns a fresh registry; the shared ``base`` is never mutated (it
    backs every worker in the team and must stay delegate-free for leaf workers)."""
    registry = ToolRegistry()
    for schema in base.list_all():
        registry.register(base.get(schema.name))
    registry.register(extra)
    return registry


def _priced_failure(
    error: str,
    *,
    model: str | None,
    usage: TokenUsage,
    rounds: int,
    duration_ms: int,
) -> RunState:
    """A FAILED RunState that still carries the tokens the run spent before it died.

    B-deep 失败计费: a hard exception used to drop a run's already-consumed usage —
    it lived only inside the ``try`` — so a worker that failed on round 4 under-billed
    rounds 1–3 (real spend on DeepSeek's side, invisible in the ledger). The
    accumulated ``usage`` is priced here exactly once (via ``calculate_cost``) so a
    failed-but-metered run produces a ledger row like any other run. ``usage``/``cost``
    are left empty when nothing was spent (run failed before any LLM call, or before
    the model tier resolved), so the per-run accumulator's ``if state.usage`` guard
    still skips a never-metered failure — no spurious zero rows.
    """
    has_usage = bool(usage.input_tokens or usage.output_tokens)
    return RunState(
        phase=RunPhase.FAILED,
        error=error,
        model=model or "",
        duration_ms=duration_ms,
        rounds=rounds,
        usage=usage.as_dict() if has_usage else {},
        cost=asdict(calculate_cost(model, usage)) if (model and has_usage) else {},
    )


def _is_hard_failure(content: str, contract: RunContract | None) -> bool:
    """Whether a contract miss should FAIL the run vs. soft-accept with a warning.

    An empty product is always hard (the non-empty baseline, 决策②); any other
    shortfall is hard only when the contract is ``strict`` (默认软提醒, 决策③)."""
    if not content.strip():
        return True
    return contract is not None and contract.strict


def _build_messages(
    plan: RunPlan,
    spec: RunSpec,
    completed: Mapping[str, RunState],
    system_prompt: str,
    user_message: str,
    contract: RunContract | None = None,
    identity: str = _WORKER_IDENTITY,
    index_paths: list[str] | None = None,
) -> list[LLMMessage]:
    """Assemble the worker's OPENING (system, user) messages from its inline role,
    the original request, its upstream dependency products, and its task.

    ``contract`` (when present) is stated up front as hard requirements so the
    worker aims to meet it on the first pass. This builds only the opening turn; a
    contract retry no longer rebuilds from scratch — the executor CONTINUES on this
    same transcript by appending the shortfall (:func:`_retry_message`), so the
    worker sees its own prior draft. ``identity`` is the worker's self-awareness
    preamble — the leaf-worker default, or the captain variant for a worker
    authorized to lead one nested sub-team."""
    sys_parts = [system_prompt, identity]
    if spec.role or spec.objective:
        sys_parts.append(f"你的角色：{spec.role}\n你的目标：{spec.objective}")
    if spec.system_prompt_supplement:
        sys_parts.append(spec.system_prompt_supplement)
    system_content = "\n\n".join(p for p in sys_parts if p)

    # 团队位置（DAG 拓扑感知）: the worker sees the team-level 原始用户请求 verbatim; on
    # its own that reads as a personal mandate, so an UPSTREAM link — blind to the
    # writer downstream — used to chase the final artifact itself (上游越权写整篇 + 无
    # 文件名的空路径 file_write). The position block hands the node its TOPOLOGY (peers +
    # where its output GOES), symmetric to _dep_context_blocks handing a downstream node
    # its upstream PRODUCTS; the request header is reframed as a team goal only when the
    # node is actually on a team (a solo worker IS the whole job).
    user_parts: list[str] = []
    position = _team_position_block(plan, spec)
    if position:
        user_parts.append(
            "## 原始用户请求（老板交给整个团队的目标，不一定全是你的活；"
            f"你的具体职责见下方「你的任务」）\n{user_message}"
        )
        user_parts.append(position)
    else:
        user_parts.append(f"## 原始用户请求\n{user_message}")
    for label, body in _dep_context_blocks(plan, spec.depends_on, completed):
        user_parts.append(f"## 前置结果（来自 {label}）\n{body}")
    # 工作区产物清单: surface files in the shared workspace this worker can file_read —
    # peer products (role-attributed) + pre-existing files (uploads / prior turns) —
    # beyond its own deps (which got the richer block above). Omitted when empty.
    manifest = _workspace_manifest(plan, completed, index_paths or [], set(spec.depends_on))
    if manifest:
        user_parts.append(
            "## 工作区现有文件（就在共享工作区，可直接 file_read 取用，避免重复劳动）\n"
            + manifest
        )
    user_parts.append(f"## 你的任务\n{spec.task}")
    if spec.expected_output:
        user_parts.append(f"## 预期产出\n{spec.expected_output}")
    requirements = describe_contract(contract)
    if requirements:
        user_parts.append(f"## 产出要求（必须满足）\n{requirements}")
    if spec.steer:
        # A mid-course user steer (plan_review adjust) injected after upstream work
        # was reviewed: stated last + highest-priority so it overrides the task
        # framing above when they conflict (结构化挂起 adjust).
        user_parts.append(
            f"## 用户中途调整指示（执行中追加，优先级最高，请据此调整工作）\n{spec.steer}"
        )

    return [
        LLMMessage(role="system", content=system_content),
        LLMMessage(role="user", content="\n\n".join(user_parts)),
    ]


def _team_position_block(plan: RunPlan, spec: RunSpec) -> str:
    """The worker's place on the team DAG: its parallel peers and — crucially — where
    its output GOES. Symmetric to :func:`_dep_context_blocks` (which hands a downstream
    node its upstream PRODUCTS): this hands a node its TOPOLOGY.

    Closes the「上游越权写最终交付物」gap: an upstream link sees the team-level
    原始用户请求 ("…保存一份报告…") but, blind to the writer downstream, used to chase the
    final artifact itself (and, lacking a filename, fire empty-path file_write). It now
    learns it is one link that hands off — and, when it does want to PERSIST a large
    intermediate product for the downstream to ``file_read``, it is told to give it a
    descriptive, role-suffixed filename (``findings-<role>.md``) instead of firing an
    empty-path ``file_write`` (the A1 递指针 affordance: lands ONLY on the upstream branch,
    where the residual empty-path attempts live, and reuses the node's role for a
    collision-free name that also satisfies the sibling "别撞文件名" directive). A TERMINAL
    node instead learns it IS the final author (reinforcing structure ownership, the
    worker-side L3 lever). Blank for a solo single worker (no team → the request simply is
    its whole job).

    Branches on shape, in priority order:
      - has dependents    → upstream link:  hands off, "别自己产最终交付物" + 中间产物落盘起名许可（A1）
      - else has upstream  → terminal node:  "你是终端环，据上游产出最终交付物"
    Parallel-peer awareness (``sibling_summary``, computed by the builder) is prepended
    in every team shape; a node with none (a lone pipeline link) skips that line."""
    roles = {n.run_id: (n.role or n.run_id) for n in plan.nodes}
    dependents = [roles[n.run_id] for n in plan.nodes if spec.run_id in n.depends_on]
    upstream = [roles[d] for d in spec.depends_on if d in roles]

    parts: list[str] = []
    if spec.sibling_summary:
        parts.append(
            "并行队友（正与你同时推进，各管一摊；据此划清职责边界，别与他们重复劳动、"
            "也别留下衔接空缺；若你们都要写文件，各自用不同的文件 / 子目录，避免互相覆盖）：\n"
            + spec.sibling_summary
        )
    if dependents:
        joined = "、".join(dependents)
        parts.append(
            f"你的产出去向：你是这条流水线的【上游一环】，你的产出是交给下游【{joined}】的"
            "【中间输入】，由其整合产出团队的最终交付物。做好你这一环、把发现 / 产物交给下游"
            "即可，【不要自己产出整个最终交付物】（如完整报告 / 最终文件）。"
            "中间产物怎么交：零散发现直接写进你的文字产出即可（会自动转交下游）；若产物较大、"
            "值得落盘供下游 file_read 取用，就调 file_write 并【自起一个描述性文件名】"
            "（如 `findings-<你的角色>.md`，带角色后缀以免与并行队友撞名），切勿用空路径。"
        )
    elif upstream:
        joined = "、".join(upstream)
        parts.append(
            f"你的位置：你是这条流水线的【终端环】。上游【{joined}】的产出已在下方「前置结果」"
            "交给你，你的职责是据此整合、产出团队交给老板的【最终交付物】。"
        )
    if not parts:
        return ""
    return "## 你在团队中的位置\n" + "\n\n".join(parts)


def _dep_context_blocks(
    plan: RunPlan, depends_on: list[str], completed: Mapping[str, RunState]
) -> list[tuple[str, str]]:
    """Render each upstream dependency's product into a ``(label, body)`` block.

    Three fidelity policies, in priority order:

    - A dep that WROTE FILES to the workspace (``files_touched`` non-empty) becomes a
      POINTER (:func:`_pointer_body`): a tight prose digest + the artifact paths to
      ``file_read``. The product is already on disk and reachable, so re-shipping it
      whole through the prompt wastes tokens and risks tail-trimming (递指针不递全文,
      Agent协作模式.md). A pointer does NOT draw on the pass_through budget.
    - ``summarize`` deps (no files) get a tight head digest (``DEP_SUMMARY_CHARS``),
      the large-fan-in token-saving case; no budget draw either.
    - ``pass_through`` PROSE deps (no file to point at — the default, for 分析/检索→写作
      链路 where 金额 / 法条编号 must survive) SHARE one per-worker total budget
      (``DEP_CONTEXT_BUDGET``), water-filled across them (:func:`_allocate`) so a single
      rich upstream passes through whole while a wide fan-in stays bounded instead of
      multiplying. A dep that still overflows its share is HEAD+TAIL trimmed
      (:func:`_truncate_head_tail`) so its tail isn't silently dropped.

    Order follows ``depends_on``; a dep with neither content nor files is skipped."""
    # mode ∈ {"pointer", "summarize", "pass_through"}
    deps: list[tuple[str, str, list[str], str]] = []  # (label, content, files, mode)
    for dep_id in depends_on:
        state = completed.get(dep_id)
        if not state or (not state.content and not state.files_touched):
            continue
        dep_spec = plan.by_id(dep_id)
        label = dep_spec.role if dep_spec and dep_spec.role else dep_id
        if state.files_touched:
            mode = "pointer"
        elif dep_spec and dep_spec.policy.result_handling == "summarize":
            mode = "summarize"
        else:
            mode = "pass_through"
        deps.append((label, state.content, list(state.files_touched), mode))

    # Only PROSE pass_through deps draw on the shared budget; pointer / summarize deps
    # are already compact and sized independently.
    allowances = iter(
        _allocate([len(c) for (_, c, _, m) in deps if m == "pass_through"], DEP_CONTEXT_BUDGET)
    )
    blocks: list[tuple[str, str]] = []
    for label, content, files, mode in deps:
        if mode == "pointer":
            body = _pointer_body(content, files)
        elif mode == "summarize":
            body = summarize(content, limit=DEP_SUMMARY_CHARS)
        else:
            body = _truncate_head_tail(content, next(allowances))
        blocks.append((label, body))
    return blocks


def _pointer_body(content: str, files: list[str]) -> str:
    """A file-producing dep's POINTER block: a tight digest of its prose handoff +
    the artifact paths to ``file_read``.

    The full product lives in the shared workspace (it called file_write), so the
    downstream pulls only what it needs rather than carrying the whole artifact in-
    prompt (递指针不递全文). The digest keeps the worker's own orientation note (改了
    哪些文件 / 怎么用 / 关键取舍, per the deliverable policy); the path list is the
    pointer. Both are bounded (``DEP_POINTER_SUMMARY_CHARS`` / ``DEP_POINTER_MAX_FILES``)."""
    parts: list[str] = []
    digest = summarize(content, limit=DEP_POINTER_SUMMARY_CHARS) if content.strip() else ""
    if digest:
        parts.append(digest)
    listed = files[:DEP_POINTER_MAX_FILES]
    lines = "\n".join(f"- {p}" for p in listed)
    more = f"\n……（共 {len(files)} 个文件）" if len(files) > len(listed) else ""
    parts.append(
        "已写入共享工作区的文件（需要完整内容请用 file_read 读取，不要凭空臆测）：\n"
        + lines
        + more
    )
    return "\n\n".join(parts)


async def _safe_index_files(backend: object) -> list[str]:
    """Best-effort flat file index of the shared workspace, for the worker manifest.

    Wraps ``backend.index_files`` so a listing failure (a dropped desktop in local
    mode, an I/O hiccup) degrades the manifest to teammate products instead of failing
    the run — workspace awareness is an enhancement, never a hard dependency. Returns
    the paths (dropping the truncation flag — the manifest caps independently)."""
    index = getattr(backend, "index_files", None)
    if index is None:
        return []
    try:
        # newest-first: in a big workspace the manifest's budget should spend on the
        # most-recently-touched files (uploads / latest outputs), not whatever sorts
        # alphabetically first.
        paths, _truncated = await index(order="recent")
        return list(paths)
    except Exception as e:  # noqa: BLE001 — manifest is best-effort, never fail a run
        logger.debug("workspace.index_failed", error=str(e))
        return []


def _workspace_manifest(
    plan: RunPlan,
    completed: Mapping[str, RunState],
    index_paths: list[str],
    exclude_runs: set[str],
) -> str:
    """A compact manifest of files in the shared workspace this worker can ``file_read``.

    Two sources, de-duped by path (a file is listed once, with the most specific label):

    1. **Peer products** — every COMPLETED teammate's ``files_touched`` (role-attributed),
       minus this worker's own deps (``exclude_runs``), which already got the richer
       pointer / product block. Listed first, in completion order.
    2. **Pre-existing files** — the rest of ``index_paths`` (the live workspace index:
       uploads, prior-turn outputs, indirectly-written artifacts), tagged「工作区已有」.
       Fed newest-first (``index_files(order="recent")``) so a big tree spends the
       budget on the most-likely-relevant files, not whatever sorts alphabetically first.

    Turns the shared workspace into a discoverable common context: a worker sees what is
    on disk and can pull it, instead of staying blind outside its dep chain (or re-
    creating something a peer / past turn already produced). Peer attribution comes from
    the completion map the scheduler hands the executor; the pre-existing set comes from a
    best-effort backend index (:func:`_safe_index_files`), so a backend without indexing
    still yields the peer-products manifest. Bounded by BOTH a file count
    (``WORKSPACE_MANIFEST_MAX_FILES``) and a char budget
    (``WORKSPACE_MANIFEST_CHAR_BUDGET``) — whichever binds first, so long paths can't
    bloat the prompt even under the count — with an elision line when more remain.
    Returns "" when nothing qualifies (the caller omits the block)."""
    # Deps' own files are surfaced in their dep block — keep them out of the manifest.
    dep_files = {
        p
        for run_id in exclude_runs
        if (st := completed.get(run_id)) is not None
        for p in st.files_touched
    }
    lines: list[str] = []
    listed: set[str] = set(dep_files)
    used = 0  # running char count, so a long-path tail can't blow the prompt budget
    truncated = False

    def _add(path: str, label: str) -> bool:
        """Add one entry; return False (and flag truncation) when a cap would be hit."""
        nonlocal used, truncated
        if path in listed:
            return True
        line = f"- {path}（{label}）"
        if len(lines) >= WORKSPACE_MANIFEST_MAX_FILES or (
            used + len(line) + 1 > WORKSPACE_MANIFEST_CHAR_BUDGET
        ):
            truncated = True
            return False
        lines.append(line)
        listed.add(path)
        used += len(line) + 1
        return True

    stop = False
    for run_id, state in completed.items():
        if stop:
            break
        if run_id in exclude_runs or not state.files_touched:
            continue
        spec = plan.by_id(run_id)
        label = f"来自 {spec.role}" if spec and spec.role else f"来自 {run_id}"
        for path in state.files_touched:
            if not _add(path, label):
                stop = True
                break
    if not stop:
        for path in index_paths:  # newest-first; take what the budget allows
            if not _add(path, "工作区已有"):
                break
    if truncated and lines:
        lines.append("……（工作区还有更多文件，需要可用 `file_list` 查看）")
    return "\n".join(lines)


def _allocate(sizes: list[int], budget: int) -> list[int]:
    """Fair-share ``budget`` across items of the given ``sizes`` (water-filling).

    Processing smallest-first, each item gets ``min(its size, an equal split of the
    budget still left)``: a small dep claims only what it needs and frees the rest,
    which redistributes to the larger deps — so the budget is used fully and a lone
    pass_through dep gets the whole of it. Returns a per-item char allowance in the
    INPUT order. ``[]`` for no items."""
    n = len(sizes)
    if n == 0:
        return []
    allowances = [0] * n
    remaining = budget
    # Smallest-first so a dep that needs less than its equal share frees the
    # remainder for the larger ones (classic water-filling).
    for rank, i in enumerate(sorted(range(n), key=lambda i: sizes[i])):
        share = remaining // (n - rank)
        allowances[i] = min(sizes[i], share)
        remaining -= allowances[i]
    return allowances


def _truncate_head_tail(content: str, limit: int) -> str:
    """Trim ``content`` to ``limit`` chars keeping BOTH ends with an elision marker
    between, so trailing details (金额 / 法条编号) survive — a head-only cut would
    silently drop them. Returns ``content`` unchanged when it already fits, ""
    when ``limit <= 0``."""
    if limit <= 0:
        return ""
    if len(content) <= limit:
        return content
    marker = "\n\n……（中间省略，已保留首尾）……\n\n"
    keep = limit - len(marker)
    if keep <= 0:
        return content[:limit].rstrip() + "…"
    head = keep * 3 // 5  # bias to the head (framing) while still keeping a real tail
    tail = keep - head
    return content[:head].rstrip() + marker + content[len(content) - tail :].lstrip()


async def _react_and_capture(
    messages: list[LLMMessage],
    *,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_ctx: ToolContext,
    profile: ModelProfile,
    allowed_tools: list[str] | None,
    run_id: str,
    agent_id: str,
    citation_sink: list[dict],
    approval_gate: ApprovalGate | None,
    usage_sink: list[TokenUsage] | None = None,
) -> tuple[str, TokenUsage, int]:
    """Run one ReAct pass over ``messages`` (mutated in place — the loop appends
    each assistant tool-call turn + tool results), then append the final assistant
    answer so the transcript ends with the worker's product.

    This is the shared core of both the initial worker run and a 续写 (auto-rework /
    revise): ``react_loop`` returns the final no-tool answer WITHOUT appending it
    (engine returns before the append), so we add it here — making ``messages`` a
    complete, replayable transcript for capture and continuation.

    ``usage_sink`` is forwarded to the loop so that when this pass raises (workers
    run with ``raise_on_error=True``), the caller can still read the tokens spent on
    the rounds that completed before the failure (B-deep 失败计费)."""
    content, _reasoning, usage, rounds = await react_loop(
        messages=messages,
        llm=llm,
        tools=tools,
        sink=sink,
        tool_context=tool_ctx,
        profile=profile,
        allowed_tool_names=allowed_tools,
        on_content=lambda d: sink.emit(run_output_delta(run_id, agent_id, d)),
        on_reasoning=lambda d: sink.emit(run_reasoning_delta(run_id, agent_id, d)),
        on_tool_progress=lambda tool, chars: sink.emit(
            run_tool_progress(run_id, agent_id, tool, chars)
        ),
        raise_on_error=True,
        citation_sink=citation_sink,
        annotate_citations=False,
        approval_gate=approval_gate,
        usage_sink=usage_sink,
        run_id=run_id,
        role="worker",
    )
    messages.append(LLMMessage(role="assistant", content=content))
    return content, usage, rounds


def _retry_message(feedback: str) -> LLMMessage:
    """The auto-rework turn appended to a worker's transcript when its product
    misses the contract. The worker now sees its own prior draft above this, so the
    feedback ("补齐差距、其余保持原样") is finally coherent (修隐患)."""
    return LLMMessage(role="user", content=feedback)


def _revision_message(feedback: str) -> LLMMessage:
    """The CEO's 热修 instruction appended to a worker's saved transcript on a
    定向唤回 (revise) — the same author continues on its own draft."""
    return LLMMessage(
        role="user",
        content=(
            f"## 修改要求（请在你上一版产出的基础上修订）\n{feedback}\n\n"
            "直接输出修订后的【完整最终产出】，未提及之处保持原样，"
            "不要解释、不要复述改动清单。"
        ),
    )


async def continue_run(
    *,
    session: RunSession,
    feedback: str,
    revision_run_id: str,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    execution_id: str,
    profile_set: ProfileSet | None = None,
    approval_gate: ApprovalGate | None = None,
) -> RunState:
    """续写 a saved worker session under the revision's log scope: binds
    run_id/agent_id/depth so all of the 热修's logs (tool.execute_end, run.*, llm.*)
    split by worker like any delegated run. Delegates to :func:`_continue_run_scoped`
    (see it for the full behavior); the scope auto-clears and is task-local."""
    with log_context(
        run_id=revision_run_id,
        agent_id=revision_run_id,
        depth=session.spec.depth,
    ):
        return await _continue_run_scoped(
            session=session,
            feedback=feedback,
            revision_run_id=revision_run_id,
            llm=llm,
            tools=tools,
            sink=sink,
            base_tool_context=base_tool_context,
            execution_id=execution_id,
            profile_set=profile_set,
            approval_gate=approval_gate,
        )


async def _continue_run_scoped(
    *,
    session: RunSession,
    feedback: str,
    revision_run_id: str,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    execution_id: str,
    profile_set: ProfileSet | None = None,
    approval_gate: ApprovalGate | None = None,
) -> RunState:
    """续写 a saved worker session: recall the SAME author to revise its own draft.

    Appends the CEO's revision instruction to the worker's preserved transcript and
    re-runs the ReAct loop under the original spec's profile / allowed tools — the
    乙 热修 path (faster, cheaper, keeps the original train of thought) vs. re-
    delegating a cold new worker (甲). Emits ``run_*`` events under
    ``revision_run_id`` parented to the original run (the graph's「修订」child node,
    P-2 版本链), prices the continuation once onto the returned RunState, and
    carries the EXTENDED transcript so the next revision continues from here. The
    contract gate is re-checked as warnings (a revision is content-quality, not a
    hard gate)."""
    profiles = profile_set or default_profile_set()
    spec = session.spec
    agent_id = revision_run_id
    # Version number for the graph's「修订 vN」child node (P4 版本链): the original is
    # v1, so the first revision (recall_count 0 here, pre-increment) is v2.
    revision = session.recall_count + 2
    sink.emit(
        run_started(
            revision_run_id,
            agent_id,
            parent_run_id=session.run_id,
            kind=spec.kind,
            revision=revision,
        )
    )
    start = time.monotonic()
    # Mirror the continuation's spend so a hard failure still bills it (B-deep 失败
    # 计费); priced_model stays None until the profile resolves (an early setup failure
    # carries no usage to price).
    inflight: list[TokenUsage] = []
    priced_model: str | None = None
    try:
        profile = apply_overrides(
            profiles.agent(spec.model_preference),
            thinking=spec.thinking,
            reasoning_effort=spec.reasoning_effort,
        )
        priced_model = profile.model
        tool_ctx = replace(
            base_tool_context,
            run_id=revision_run_id,
            agent_id=agent_id,
            execution_id=execution_id,
        )
        # Continue on a COPY so a failed continuation leaves the stored session
        # intact (the caller only commits the extended transcript on success).
        messages = list(session.transcript)
        messages.append(_revision_message(feedback))
        citations: list[dict] = []
        content, round_usage, round_rounds = await _react_and_capture(
            messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_ctx=tool_ctx,
            profile=profile,
            allowed_tools=spec.tools,
            run_id=revision_run_id,
            agent_id=agent_id,
            citation_sink=citations,
            approval_gate=approval_gate,
            usage_sink=inflight,
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        usage = round_usage.as_dict()
        cost = asdict(calculate_cost(profile.model, round_usage))
        # files_written counts the whole continued transcript (original draft + this
        # revision), so a requires_files contract isn't spuriously flagged when the
        # recall edits prose around files the first pass already wrote.
        verdict = check_contract(
            content,
            spec.policy.contract,
            files_written=len(files_touched_from_transcript(messages)),
        )
        # 执行级事件溯源 (§18.3): the revised FULL product under the revision run id,
        # so the version chain's latest output is reconstructable from the journal.
        record_turn_fact(
            MessageFinalFact(run_id=revision_run_id, content=content).to_fact()
        )
        sink.emit(
            run_completed(
                revision_run_id,
                agent_id,
                output_summary=summarize(content),
                duration_ms=duration_ms,
                role="member",
                model=profile.model,
                usage=usage,
                cost=cost,
            )
        )
        return RunState(
            phase=RunPhase.COMPLETED,
            content=content,
            warnings=[] if verdict.ok else list(verdict.failures),
            citations=citations,
            model=profile.model,
            duration_ms=duration_ms,
            rounds=round_rounds,
            files_touched=files_touched_from_transcript(messages),
            usage=usage,
            cost=cost,
            transcript=messages,
        )
    except Exception as e:  # noqa: BLE001 — surface any revision failure to UI/state
        duration_ms = int((time.monotonic() - start) * 1000)
        partial = inflight[0] if inflight else TokenUsage()
        logger.error("run.revise_failed", run_id=revision_run_id, error=str(e), exc_info=True)
        sink.emit(run_failed(revision_run_id, agent_id, str(e)))
        return _priced_failure(
            str(e),
            model=priced_model,
            usage=partial,
            rounds=0,
            duration_ms=duration_ms,
        )
