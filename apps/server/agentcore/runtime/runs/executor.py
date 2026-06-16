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
    run_completed,
    run_failed,
    run_output_delta,
    run_reasoning_delta,
    run_started,
)
from agentcore.runtime.runs.constants import (
    DEFAULT_CONTRACT_RETRIES,
    MAX_CONTRACT_RETRIES,
    MAX_DELEGATION_DEPTH,
)
from agentcore.runtime.runs.contract import (
    ContractVerdict,
    check_contract,
    describe_contract,
    format_feedback,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import RunExecutor
from agentcore.runtime.runs.session import RunSession
from agentcore.runtime.runs.types import RunContract, RunPhase, RunSpec, RunState
from agentcore.runtime.workspace import summarize
from agentcore.tools.protocol import Tool, ToolContext
from agentcore.tools.registry import ToolRegistry

# A worker's nested-delegate factory: given (captain_run_id, captain_depth) — the
# worker's own run id + depth — it mints a ``delegate`` tool bound to that worker
# as the sub-team's captain. Owned by the DelegateTool (which can import the tools
# package), passed in here so ``runs`` stays free of a tools dependency.
DelegateFactory = Callable[[str, int], Tool]

logger = get_logger(__name__)

# Hard cap on a pass_through upstream product injected into a downstream prompt,
# so a long upstream answer can't blow the dependent's context window. A node
# whose policy declares ``result_handling="summarize"`` gets a tight summary
# instead.
_DEP_PASS_THROUGH_CAP = 4000

# Prepended to every delegated worker's system prompt (right after the shared
# base). A worker runs in an isolated context with one scoped task, no chance to
# ask follow-ups, and no `delegate` tool — stated explicitly so it makes a
# reasonable assumption and delivers, instead of punting with a clarifying
# question it can never get answered. It is also told its product is shown to the
# user directly (drillable in the UI) and flows back to the CEO, to motivate
# self-contained, user-ready quality rather than writing only for the CEO.
_WORKER_IDENTITY = """\
你是团队中的一名专家 worker。你只负责一个划定好的任务，外加完成它所需的上下文；\
你不会有机会追问澄清，也不能再向下委派。如果某处信息不足，就做出最合理的假设、\
简短说明，然后照常交付你的最佳结果。直接以任务要求的产出开头，保持自包含，不要写\
“我是一个 agent”之类的元叙述。你的完整产出会在界面上直接展示给用户、也会回流给\
主 Agent 整合，因此要完整、准确、可独立阅读；若任务附带了产出要求，逐条满足。"""

# Variant identity for a worker that opted into one nested delegation level
# (``can_delegate`` and still above the depth cap). Unlike the leaf worker it MAY
# call ``delegate`` once to split its task across a small sub-team it commands —
# but only when the work genuinely needs it, and its own sub-workers cannot
# delegate further (the executor withholds the tool from them).
_WORKER_CAPTAIN_IDENTITY = """\
你是团队中的一名专家 worker，并且被额外授权可以再向下委派一层子团队。你负责一个划定\
好的任务，外加完成它所需的上下文；你不会有机会追问澄清。如果这个任务复杂到需要进一步\
拆分，你可以调用 delegate 把它拆给一支由你指挥的子团队（只能再嵌套这一层，你的子成员\
不能再向下委派），看到他们的产出后由你整合；若任务并不需要拆分，就自己直接完成，不要\
为委派而委派。信息不足时做出最合理的假设、简短说明，然后照常交付。直接以任务要求的产\
出开头，保持自包含，不要写“我是一个 agent”之类的元叙述。你的完整产出会在界面上直接\
展示给用户、也会回流给主 Agent 整合，因此要完整、准确、可独立阅读；若任务附带了产出\
要求，逐条满足。"""


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
        try:
            profile = apply_overrides(
                profiles.agent(spec.model_preference),
                thinking=spec.thinking,
                reasoning_effort=spec.reasoning_effort,
            )
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
            allowed_tools = spec.tools
            identity = _WORKER_IDENTITY
            if (
                delegate_factory is not None
                and spec.can_delegate
                and spec.depth < MAX_DELEGATION_DEPTH
            ):
                child_delegate = delegate_factory(spec.run_id, spec.depth)
                worker_tools = _registry_with(tools, child_delegate)
                allowed_tools = [*spec.tools, child_delegate.schema.name]
                identity = _WORKER_CAPTAIN_IDENTITY
            # Produce → check contract → re-prompt with the specific shortfalls.
            # This content-quality retry is intentionally separate from the
            # scheduler's infra-failure retry (RunPolicy.on_failure): they answer
            # different questions and must not be conflated.
            run_usage = TokenUsage()
            run_rounds = 0
            content = ""
            verdict = ContractVerdict(ok=True)
            # Web sources this worker consults, de-duped across contract retries.
            # Collect-only (annotate_citations=False): the worker text stays
            # un-numbered; the DelegateTool folds these into the turn's shared
            # source card so the user sees the WHOLE team's research, not just the
            # CEO's own searches.
            worker_citations: list[dict] = []
            # Build the worker's opening (system + task) ONCE; auto-rework then
            # CONTINUES on this SAME transcript (append the shortfall, re-run)
            # instead of rebuilding from scratch — so the worker sees its own prior
            # draft when correcting (修隐患), and the finished transcript is captured
            # as a recoverable RunSession for 定向唤回 (统一「续写」原语, 见 §三).
            messages = _build_messages(
                plan, spec, completed, system_prompt, user_message, contract, identity=identity
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
                )
                run_usage = run_usage + round_usage
                run_rounds += round_rounds
                verdict = check_contract(content, contract)
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
            if not verdict.ok and _is_hard_failure(content, contract):
                reason = "；".join(verdict.failures)
                logger.info("contract.failed", run_id=spec.run_id, failures=verdict.failures)
                sink.emit(run_failed(spec.run_id, agent_id, reason))
                return RunState(
                    phase=RunPhase.FAILED,
                    content=content,
                    error=reason,
                    citations=worker_citations,
                    model=profile.model,
                    duration_ms=duration_ms,
                    rounds=run_rounds,
                    usage=usage,
                    cost=cost,
                    transcript=messages,
                )
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
                citations=worker_citations,
                model=profile.model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                usage=usage,
                cost=cost,
                transcript=messages,
            )
        except Exception as e:  # noqa: BLE001 — surface any run failure to UI/state
            duration_ms = int((time.monotonic() - start) * 1000)
            logger.error("run.failed", run_id=spec.run_id, error=str(e), exc_info=True)
            sink.emit(run_failed(spec.run_id, agent_id, str(e)))
            return RunState(phase=RunPhase.FAILED, error=str(e), duration_ms=duration_ms)

    async def execute(spec: RunSpec, completed: Mapping[str, RunState]) -> RunState:
        # Bind this worker's identity so EVERY log emitted under it (tool.execute_end,
        # contract.*, run.*, llm.*, react_loop internals) carries run_id/agent_id/
        # depth — analysis can then split tool quality + events by worker. The scope
        # auto-clears on exit; contextvars are task-local, so concurrent workers in a
        # wave never bleed identities into one another.
        agent_id = spec.agent_id or spec.run_id
        with log_context(run_id=spec.run_id, agent_id=agent_id, depth=spec.depth):
            return await _execute_node(spec, completed, agent_id)

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
        agent_id = spec.agent_id or spec.run_id
        sink.emit(run_started(spec.run_id, agent_id, parent_run_id=None, kind=spec.kind))
        start = time.monotonic()
        try:
            tool_ctx = replace(
                base_tool_context, run_id=spec.run_id, agent_id=agent_id
            )
            messages = [LLMMessage(role="system", content=chat_system_prompt)]
            for msg in history:
                messages.append(LLMMessage(role=msg["role"], content=msg["content"]))
            messages.append(LLMMessage(role="user", content=user_message))

            content, reasoning, usage, rounds = await react_loop(
                messages=messages,
                llm=llm,
                tools=tools,
                sink=sink,
                tool_context=tool_ctx,
                profile=profile,
                citation_sink=citation_sink,
                annotate_citations=True,
                approval_gate=approval_gate,
            )
            duration_ms = int((time.monotonic() - start) * 1000)
            usage_dict = usage.as_dict()
            cost = asdict(calculate_cost(profile.model, usage))
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
            )
        except Exception as e:  # noqa: BLE001 — surface any captain failure to UI/state
            duration_ms = int((time.monotonic() - start) * 1000)
            logger.error("run.captain_failed", run_id=spec.run_id, error=str(e), exc_info=True)
            sink.emit(run_failed(spec.run_id, agent_id, str(e)))
            return RunState(phase=RunPhase.FAILED, error=str(e), duration_ms=duration_ms)

    return execute


def _registry_with(base: ToolRegistry, extra: Tool) -> ToolRegistry:
    """A per-worker registry = the shared team tools + one extra tool (its nested
    delegate). Returns a fresh registry; the shared ``base`` is never mutated (it
    backs every worker in the team and must stay delegate-free for leaf workers)."""
    registry = ToolRegistry()
    for schema in base.list_all():
        registry.register(base.get(schema.name))
    registry.register(extra)
    return registry


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

    user_parts: list[str] = [f"## 原始用户请求\n{user_message}"]
    if spec.sibling_summary:
        user_parts.append(f"## 同时进行的其他任务\n{spec.sibling_summary}")
    for dep_id in spec.depends_on:
        dep_state = completed.get(dep_id)
        if not dep_state or not dep_state.content:
            continue
        dep_spec = plan.by_id(dep_id)
        label = dep_spec.role if dep_spec and dep_spec.role else dep_id
        user_parts.append(f"## 前置结果（来自 {label}）\n{_dep_body(dep_spec, dep_state.content)}")
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


def _dep_body(dep_spec: RunSpec | None, content: str) -> str:
    """Size an upstream product for injection: a tight summary when the dep
    declared ``result_handling="summarize"``, else pass_through with a hard cap."""
    if dep_spec and dep_spec.policy.result_handling == "summarize":
        return summarize(content, limit=600)
    if len(content) > _DEP_PASS_THROUGH_CAP:
        return content[:_DEP_PASS_THROUGH_CAP].rstrip() + "…"
    return content


async def _react_and_capture(
    messages: list[LLMMessage],
    *,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_ctx: ToolContext,
    profile: ModelProfile,
    allowed_tools: list[str],
    run_id: str,
    agent_id: str,
    citation_sink: list[dict],
    approval_gate: ApprovalGate | None,
) -> tuple[str, TokenUsage, int]:
    """Run one ReAct pass over ``messages`` (mutated in place — the loop appends
    each assistant tool-call turn + tool results), then append the final assistant
    answer so the transcript ends with the worker's product.

    This is the shared core of both the initial worker run and a 续写 (auto-rework /
    revise): ``react_loop`` returns the final no-tool answer WITHOUT appending it
    (engine returns before the append), so we add it here — making ``messages`` a
    complete, replayable transcript for capture and continuation."""
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
        raise_on_error=True,
        citation_sink=citation_sink,
        annotate_citations=False,
        approval_gate=approval_gate,
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
    try:
        profile = apply_overrides(
            profiles.agent(spec.model_preference),
            thinking=spec.thinking,
            reasoning_effort=spec.reasoning_effort,
        )
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
        )
        duration_ms = int((time.monotonic() - start) * 1000)
        usage = round_usage.as_dict()
        cost = asdict(calculate_cost(profile.model, round_usage))
        verdict = check_contract(content, spec.policy.contract)
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
            usage=usage,
            cost=cost,
            transcript=messages,
        )
    except Exception as e:  # noqa: BLE001 — surface any revision failure to UI/state
        duration_ms = int((time.monotonic() - start) * 1000)
        logger.error("run.revise_failed", run_id=revision_run_id, error=str(e), exc_info=True)
        sink.emit(run_failed(revision_run_id, agent_id, str(e)))
        return RunState(phase=RunPhase.FAILED, error=str(e), duration_ms=duration_ms)
