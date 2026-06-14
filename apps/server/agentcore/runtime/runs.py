"""Run model: multi-agent DAG scheduling.

Executes an OrchestratorPlan as a DAG of runs. Each step is one run, executed by
the shared ReAct loop (engine.react_loop). Steps with satisfied dependencies run
concurrently (bounded by max_parallel); dependents wait. Upstream summaries are
injected into downstream prompts via the TaskWorkspace.

Emits run_* SSE events so the frontend graph view lights up in real time. At a
checkpoint the scheduler suspends on the interaction primitive and waits for the
user's decision (continue / adjust / stop). When all runs settle, a synthesis
pass produces the final user-facing answer (streamed as content_delta).
"""

import asyncio
import time
from dataclasses import replace

from agentcore.core.logging import get_logger
from agentcore.core.types import StepStatus, new_id
from agentcore.llm.config import agent_profile, apply_overrides, get_profile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage
from agentcore.runtime.checkpoint_review import review_checkpoint
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import (
    EventSink,
    approval_required,
    approval_resolved,
    checkpoint_review,
    content_delta,
    plan_review_required,
    plan_review_resolved,
    run_completed,
    run_failed,
    run_output_delta,
    run_plan,
    run_progress,
    run_started,
)
from agentcore.runtime.interactions import AgentOverride, interaction_registry
from agentcore.runtime.plan import (
    OrchestratorPlan,
    PlannedAgent,
    PlannedCheckpoint,
    PlannedStep,
)
from agentcore.runtime.workspace import StepOutput, TaskWorkspace, summarize
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)

_CHECKPOINT_TIMEOUT_S = 600.0
_PLAN_REVIEW_TIMEOUT_S = 600.0
_VALID_TIERS = {"fast", "strong"}
_VALID_EFFORTS = {"high", "max"}


def _effective_knobs(agent: PlannedAgent | None) -> tuple[bool, str | None]:
    """Resolve an agent's *effective* (thinking, reasoning_effort) for display.

    Folds the tier default and any per-agent override through the same
    upgrade-only clamp the run uses (提案 B), so the team preview and graph show
    exactly what will run — not the raw declaration.
    """
    pref = agent.model_preference if agent else "strong"
    thinking = agent.thinking if agent else None
    effort = agent.reasoning_effort if agent else None
    profile = apply_overrides(agent_profile(pref), thinking=thinking, reasoning_effort=effort)
    return profile.thinking, profile.reasoning_effort


def _agent_card(agent: PlannedAgent) -> dict[str, object]:
    """Roster entry shared by the run_plan and plan_review_required events."""
    thinking, effort = _effective_knobs(agent)
    return {
        "id": agent.id,
        "role": agent.role,
        "model_preference": agent.model_preference,
        "thinking": thinking,
        "reasoning_effort": effort,
    }


def _apply_review_overrides(
    plan: OrchestratorPlan, overrides: dict[str, AgentOverride]
) -> None:
    """Apply the user's team-preview overrides onto the plan in place.

    The user's choice is authoritative-replace for the agents it names (the
    client always sends each agent's full intended state). Invalid tier/effort
    values are dropped; the run's ``apply_overrides`` still clamps the final
    thinking/effort upgrade-only against the tier baseline.
    """
    for agent in plan.agents:
        ov = overrides.get(agent.id)
        if ov is None:
            continue
        if ov.model_preference in _VALID_TIERS:
            agent.model_preference = ov.model_preference
        agent.thinking = ov.thinking if isinstance(ov.thinking, bool) else None
        agent.reasoning_effort = (
            ov.reasoning_effort if ov.reasoning_effort in _VALID_EFFORTS else None
        )


async def _await_plan_review(
    *,
    plan: OrchestratorPlan,
    execution_id: str,
    sink: EventSink,
) -> bool:
    """Pre-execution gate: pause for the user to review/adjust the team.

    Emits ``plan_review_required`` and suspends on the interaction primitive
    until the user resolves it. On "start", any per-agent model overrides (tier
    + thinking/effort) are applied to ``plan`` in place, so the existing
    ``run_one`` profile resolution just works. Returns True to proceed, False if
    the user cancelled.

    Timing out (no response) defaults to proceeding with the orchestrator's
    original tiers — the gate must never block a run forever.
    """
    review_id = new_id()
    future = interaction_registry.create(review_id)
    sink.emit(
        plan_review_required(
            review_id=review_id,
            execution_id=execution_id,
            agents=[_agent_card(a) for a in plan.agents],
        )
    )
    response = await interaction_registry.wait(
        future, review_id, timeout=_PLAN_REVIEW_TIMEOUT_S
    )
    action = response.action if response else "start"

    if action == "cancel":
        sink.emit(plan_review_resolved(review_id, "cancel"))
        return False

    if response and response.overrides:
        _apply_review_overrides(plan, response.overrides)

    sink.emit(plan_review_resolved(review_id, "start"))
    return True


async def run_multi_agent(
    *,
    plan: OrchestratorPlan,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    system_prompt: str,
    user_message: str,
) -> dict:
    """Execute a multi-agent plan and synthesize the final answer.

    Returns {content, input_tokens, output_tokens, reasoning_tokens}.
    """
    execution_id = base_tool_context.execution_id or new_id()
    workspace = TaskWorkspace(execution_id)
    steps_by_id: dict[str, PlannedStep] = {s.id: s for s in plan.steps}
    checkpoints_by_step: dict[str, PlannedCheckpoint] = {c.after_step: c for c in plan.checkpoints}
    total_steps = len(plan.steps)

    sink.emit(
        run_plan(
            execution_id=execution_id,
            plan_type="multi_agent",
            task_summary=plan.task_summary,
            agents=[_agent_card(a) for a in plan.agents],
            steps=[
                {
                    "id": s.id,
                    "agent_id": s.agent_id,
                    "task": s.task,
                    "depends_on": s.depends_on,
                }
                for s in plan.steps
            ],
        )
    )

    # Pre-execution gate: let the user review the team and override model tiers
    # before anything runs. Cancelling here aborts the run cleanly.
    proceed = await _await_plan_review(plan=plan, execution_id=execution_id, sink=sink)
    if not proceed:
        message = "已取消执行。"
        sink.emit(content_delta(message))
        return {
            "content": message,
            "reasoning_content": "",
            "input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
        }

    status: dict[str, StepStatus] = {s.id: StepStatus.PENDING for s in plan.steps}
    totals = {"input": 0, "output": 0, "reasoning": 0}
    adjustment: dict[str, str | None] = {"feedback": None}
    stop_requested = False

    def completed_count() -> int:
        return sum(1 for st in status.values() if st == StepStatus.COMPLETED)

    async def run_one(step: PlannedStep) -> StepOutput:
        agent = plan.agent_by_id(step.agent_id)
        pref = agent.model_preference if agent else "strong"
        # Tier picks the base套餐; per-agent overrides (upgrade-only) unlock
        # thinking/max on this specific agent without raising the whole tier.
        profile = apply_overrides(
            agent_profile(pref),
            thinking=agent.thinking if agent else None,
            reasoning_effort=agent.reasoning_effort if agent else None,
        )

        sys_parts = [system_prompt]
        if agent and (agent.role or agent.objective):
            sys_parts.append(f"你的角色：{agent.role}\n你的目标：{agent.objective}")
        if agent and agent.system_prompt_supplement:
            sys_parts.append(agent.system_prompt_supplement)
        system_content = "\n\n".join(p for p in sys_parts if p)

        user_parts: list[str] = []
        if adjustment["feedback"]:
            user_parts.append(f"## 用户补充指令\n{adjustment['feedback']}")
        user_parts.append(f"## 原始用户请求\n{user_message}")
        for dep_id in step.depends_on:
            dep_out = workspace.get_output(dep_id)
            if dep_out:
                user_parts.append(f"## 前置结果（来自 {dep_out.role}）\n{dep_out.summary}")
        user_parts.append(f"## 你的任务\n{step.task}")
        if step.expected_output:
            user_parts.append(f"## 预期产出\n{step.expected_output}")

        messages = [
            LLMMessage(role="system", content=system_content),
            LLMMessage(role="user", content="\n\n".join(user_parts)),
        ]
        tool_ctx = replace(
            base_tool_context,
            step_id=step.id,
            agent_id=step.agent_id,
            execution_id=execution_id,
        )

        start = time.monotonic()
        content, _reasoning, t_in, t_out, t_reason, _rounds = await react_loop(
            messages=messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_context=tool_ctx,
            profile=profile,
            allowed_tool_names=agent.tools if agent else [],
            on_content=lambda d, rid=step.id, aid=step.agent_id: sink.emit(
                run_output_delta(rid, aid, d)
            ),
            on_reasoning=lambda _d: None,
            raise_on_error=True,
        )
        totals["input"] += t_in
        totals["output"] += t_out
        totals["reasoning"] += t_reason
        return StepOutput(
            step_id=step.id,
            agent_id=step.agent_id,
            role=agent.role if agent else step.agent_id,
            content=content,
            summary=summarize(content),
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    async def handle_checkpoint(cp: PlannedCheckpoint, step_id: str) -> str:
        """Review a checkpoint. The orchestrator decides continue / adjust /
        escalate; only escalate hands the call to the user. Returns the action
        that matters to the scheduler ("stop" cancels the rest)."""
        checkpoint_id = new_id()
        out = workspace.get_output(step_id)
        summary = out.summary if out else ""

        decision = await review_checkpoint(
            llm=llm,
            task_summary=plan.task_summary,
            step_role=out.role if out else step_id,
            step_task=steps_by_id[step_id].task,
            output=out.content if out else "",
            review_focus=cp.review_focus,
            fallback_reason=cp.reason,
        )
        sink.emit(
            checkpoint_review(
                checkpoint_id=checkpoint_id,
                after_step=step_id,
                decision=decision.decision,
                reason=decision.reason or cp.reason,
                summary=summary,
            )
        )

        if decision.decision == "continue":
            return "continue"
        if decision.decision == "adjust":
            if decision.feedback:
                adjustment["feedback"] = decision.feedback
            return "adjust"

        # escalate → hand the decision to the user (approve / adjust / stop)
        future = interaction_registry.create(checkpoint_id)
        sink.emit(
            approval_required(
                checkpoint_id=checkpoint_id,
                after_step=step_id,
                summary=summary,
                reason=decision.reason or cp.reason or "请确认是否继续执行后续步骤",
                actions=["approve", "adjust", "stop"],
            )
        )
        response = await interaction_registry.wait(
            future, checkpoint_id, timeout=_CHECKPOINT_TIMEOUT_S
        )
        action = response.action if response else "approve"
        if action == "adjust" and response and response.feedback:
            adjustment["feedback"] = response.feedback
        sink.emit(approval_resolved(checkpoint_id, action))
        return action

    running: dict[asyncio.Task, str] = {}
    try:
        while True:
            if stop_requested:
                break

            for s in plan.steps:
                if status[s.id] == StepStatus.PENDING and any(
                    status[d] in (StepStatus.FAILED, StepStatus.CANCELLED) for d in s.depends_on
                ):
                    status[s.id] = StepStatus.CANCELLED
                    sink.emit(run_progress(completed_count(), total_steps))

            ready = [
                s
                for s in plan.steps
                if status[s.id] == StepStatus.PENDING
                and all(status[d] == StepStatus.COMPLETED for d in s.depends_on)
            ]
            slots = max(0, plan.max_parallel - len(running))
            for step in ready[:slots]:
                status[step.id] = StepStatus.RUNNING
                sink.emit(run_started(step.id, step.agent_id, step.id))
                running[asyncio.create_task(run_one(step))] = step.id

            if not running:
                break

            done, _ = await asyncio.wait(list(running), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                sid = running.pop(task)
                step = steps_by_id[sid]
                try:
                    output = task.result()
                    status[sid] = StepStatus.COMPLETED
                    workspace.write_output(output)
                    sink.emit(
                        run_completed(
                            sid,
                            step.agent_id,
                            output_summary=output.summary,
                            duration_ms=output.duration_ms,
                        )
                    )
                except Exception as e:  # noqa: BLE001 — surface any run failure to UI
                    status[sid] = StepStatus.FAILED
                    logger.error("run_failed", step_id=sid, error=str(e), exc_info=True)
                    sink.emit(run_failed(sid, step.agent_id, str(e)))
                sink.emit(run_progress(completed_count(), total_steps))

                ready_for_checkpoint = (
                    status[sid] == StepStatus.COMPLETED
                    and sid in checkpoints_by_step
                    and not stop_requested
                )
                if (
                    ready_for_checkpoint
                    and await handle_checkpoint(checkpoints_by_step[sid], sid) == "stop"
                ):
                    stop_requested = True
    finally:
        # Never let detached run_one tasks outlive the scheduler. Covers both the
        # graceful stop path (user chose "stop" at a checkpoint) and hard
        # cancellation (a client disconnect cancels this coroutine mid-await):
        # without this, a cancelled turn would leave agents running in the dark.
        leftover = list(running)
        for task in leftover:
            task.cancel()
        if leftover:
            await asyncio.gather(*leftover, return_exceptions=True)
        running.clear()

    if stop_requested:
        for s in plan.steps:
            if status[s.id] == StepStatus.PENDING:
                status[s.id] = StepStatus.CANCELLED
        sink.emit(run_progress(completed_count(), total_steps))

    final_content, final_reasoning = await _synthesize(
        plan=plan,
        workspace=workspace,
        llm=llm,
        tools=tools,
        sink=sink,
        base_tool_context=base_tool_context,
        execution_id=execution_id,
        user_message=user_message,
        totals=totals,
        stopped=stop_requested,
    )

    return {
        "content": final_content,
        "reasoning_content": final_reasoning,
        "input_tokens": totals["input"],
        "output_tokens": totals["output"],
        "reasoning_tokens": totals["reasoning"],
    }


async def _synthesize(
    *,
    plan: OrchestratorPlan,
    workspace: TaskWorkspace,
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    base_tool_context: ToolContext,
    execution_id: str,
    user_message: str,
    totals: dict[str, int],
    stopped: bool,
) -> tuple[str, str]:
    """Produce the final user-facing answer, streamed as content_delta.

    Returns (content, reasoning). ``reasoning`` is the synthesizer's thinking
    text — the model reasoning behind the final answer — for persistence;
    short-circuit paths (no synthesis call) return an empty reasoning string.
    """
    outputs = [workspace.get_output(s.id) for s in plan.steps if workspace.get_output(s.id)]

    if not outputs:
        message = "执行已停止，未产生结果。" if stopped else "未能产生结果。"
        sink.emit(content_delta(message))
        return message, ""

    if len(outputs) == 1 and plan.output_strategy.merge_type == "direct":
        sink.emit(content_delta(outputs[0].content))
        return outputs[0].content, ""

    context_blocks = "\n\n".join(f"### {o.role}（{o.agent_id}）\n{o.content}" for o in outputs)
    note = "（注意：部分步骤被用户中途停止，请基于已完成的部分作答。）" if stopped else ""
    system_content = (
        "你是一名汇总助手。多个 Agent 已分别完成了各自的子任务，"
        "你的职责是把它们的成果整合成一份连贯、完整、直接面向用户的最终回复。"
        "不要提及内部的 Agent、步骤或执行细节，直接给出用户想要的答案。"
        "使用与用户相同的语言。"
    )
    user_content = (
        f"## 用户的原始请求\n{user_message}\n\n"
        f"## 各 Agent 的成果{note}\n{context_blocks}\n\n"
        "## 你的任务\n基于以上成果，给出最终回复。"
    )

    tool_ctx = replace(
        base_tool_context,
        step_id=new_id(),
        agent_id="synthesizer",
        execution_id=execution_id,
    )

    content, reasoning, t_in, t_out, t_reason, _rounds = await react_loop(
        messages=[
            LLMMessage(role="system", content=system_content),
            LLMMessage(role="user", content=user_content),
        ],
        llm=llm,
        tools=tools,
        sink=sink,
        tool_context=tool_ctx,
        profile=get_profile("synthesizer"),
        allowed_tool_names=[],
    )
    totals["input"] += t_in
    totals["output"] += t_out
    totals["reasoning"] += t_reason
    return content, reasoning
