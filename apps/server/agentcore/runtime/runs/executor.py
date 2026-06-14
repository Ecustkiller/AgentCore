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
from collections.abc import Mapping
from dataclasses import asdict, replace

from agentcore.core.logging import get_logger
from agentcore.llm.config import agent_profile, apply_overrides
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import (
    EventSink,
    run_completed,
    run_failed,
    run_output_delta,
    run_reasoning_delta,
    run_started,
)
from agentcore.runtime.runs.constants import DEFAULT_CONTRACT_RETRIES, MAX_CONTRACT_RETRIES
from agentcore.runtime.runs.contract import (
    ContractVerdict,
    check_contract,
    describe_contract,
    format_feedback,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import RunExecutor
from agentcore.runtime.runs.types import RunContract, RunPhase, RunSpec, RunState
from agentcore.runtime.workspace import summarize
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

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
# question it can never get answered.
_WORKER_IDENTITY = """\
你是团队中的一名专家 worker。你只负责一个划定好的任务，外加完成它所需的上下文；\
你不会有机会追问澄清，也不能再向下委派。如果某处信息不足，就做出最合理的假设、\
简短说明，然后照常交付你的最佳结果。直接以任务要求的产出开头，保持自包含，不要写\
“我是一个 agent”之类的元叙述。"""


def build_agent_executor(
    *,
    plan: RunPlan,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    system_prompt: str,
    user_message: str,
    execution_id: str,
) -> RunExecutor:
    """Build a :class:`RunExecutor` bound to one turn's wiring.

    Closes over ``plan`` so a node can resolve a dependency's display role when
    labelling injected upstream context; the scheduler passes only the terminal
    ``completed`` states per call.
    """

    async def execute(spec: RunSpec, completed: Mapping[str, RunState]) -> RunState:
        agent_id = spec.agent_id or spec.run_id
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
                agent_profile(spec.model_preference),
                thinking=spec.thinking,
                reasoning_effort=spec.reasoning_effort,
            )
            tool_ctx = replace(
                base_tool_context,
                run_id=spec.run_id,
                agent_id=agent_id,
                execution_id=execution_id,
            )
            # Produce → check contract → re-prompt with the specific shortfalls.
            # This content-quality retry is intentionally separate from the
            # scheduler's infra-failure retry (RunPolicy.on_failure): they answer
            # different questions and must not be conflated.
            run_usage = TokenUsage()
            run_rounds = 0
            content = ""
            verdict = ContractVerdict(ok=True)
            feedback = ""
            attempts = 1 + min(DEFAULT_CONTRACT_RETRIES, MAX_CONTRACT_RETRIES)
            for attempt in range(attempts):
                messages = _build_messages(
                    plan, spec, completed, system_prompt, user_message, contract, feedback
                )
                content, _reasoning, round_usage, round_rounds = await react_loop(
                    messages=messages,
                    llm=llm,
                    tools=tools,
                    sink=sink,
                    tool_context=tool_ctx,
                    profile=profile,
                    allowed_tool_names=spec.tools,
                    on_content=lambda d, rid=spec.run_id, aid=agent_id: sink.emit(
                        run_output_delta(rid, aid, d)
                    ),
                    on_reasoning=lambda d, rid=spec.run_id, aid=agent_id: sink.emit(
                        run_reasoning_delta(rid, aid, d)
                    ),
                    raise_on_error=True,
                )
                run_usage = run_usage + round_usage
                run_rounds += round_rounds
                verdict = check_contract(content, contract)
                if verdict.ok or attempt == attempts - 1:
                    break
                feedback = format_feedback(verdict)
                logger.info(
                    "contract_retry",
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
                logger.info("contract_failed", run_id=spec.run_id, failures=verdict.failures)
                sink.emit(run_failed(spec.run_id, agent_id, reason))
                return RunState(
                    phase=RunPhase.FAILED,
                    content=content,
                    error=reason,
                    model=profile.model,
                    duration_ms=duration_ms,
                    rounds=run_rounds,
                    usage=usage,
                    cost=cost,
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
                model=profile.model,
                duration_ms=duration_ms,
                rounds=run_rounds,
                usage=usage,
                cost=cost,
            )
        except Exception as e:  # noqa: BLE001 — surface any run failure to UI/state
            duration_ms = int((time.monotonic() - start) * 1000)
            logger.error("run_failed", run_id=spec.run_id, error=str(e), exc_info=True)
            sink.emit(run_failed(spec.run_id, agent_id, str(e)))
            return RunState(phase=RunPhase.FAILED, error=str(e), duration_ms=duration_ms)

    return execute


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
    feedback: str = "",
) -> list[LLMMessage]:
    """Assemble the worker's (system, user) messages from its inline role, the
    original request, its upstream dependency products, and its task.

    ``contract`` (when present) is stated up front as hard requirements so the
    worker aims to meet it on the first pass; ``feedback`` carries the prior
    attempt's specific shortfalls on a contract retry."""
    sys_parts = [system_prompt, _WORKER_IDENTITY]
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
    if feedback:
        user_parts.append(f"## 上一次未达标，请修正后重做\n{feedback}")

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
