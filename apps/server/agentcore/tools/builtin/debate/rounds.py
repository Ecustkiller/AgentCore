"""辩手轮次驱动：首轮并行派工 + 后续轮 continue_run。"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger
from agentcore.runtime.debate import DebateConfig, DebateSide, RoundResult, SideTurn
from agentcore.tools.builtin.debate.prompt import debater_task, round_feedback

if TYPE_CHECKING:
    from agentcore.tools.builtin.debate.tool import DebateTool

logger = get_logger(__name__)


def failed_turn(side: DebateSide, run_id: str) -> SideTurn:
    return SideTurn(side.key, side.name, run_id, "", ok=False)


def make_round_runner(
    tool: DebateTool, execution_id: str, moderator_run_id: str, config: DebateConfig
):
    async def run_round(*, round_no, focus, sides, history, interjections=()):
        if round_no <= 1 or not tool._debater_sessions:
            # 首轮无前序边界 ⇒ 恒无用户追问（追问只在第 1 轮之后的边界产生）。
            return await first_round(tool, execution_id, moderator_run_id, config, focus, sides)
        return await next_round(
            tool,
            execution_id,
            moderator_run_id,
            config,
            round_no,
            focus,
            sides,
            history,
            interjections,
        )

    return run_round


async def first_round(
    tool: DebateTool,
    execution_id: str,
    moderator_run_id: str,
    config: DebateConfig,
    focus: str,
    sides,
) -> list[SideTurn]:
    """首轮：build_run_plan 一波并行辩手 → executor → 留人 → 折算 → SideTurn。"""
    from agentcore.runtime.runs import (
        DEFAULT_MAX_PARALLEL,
        BatchMetrics,
        RunPhase,
        RunSession,
        WaveScheduler,
        build_agent_executor,
        build_run_plan,
    )

    sides = list(sides)
    # 结构化补轮·B：若本回合带上一场种子，首轮辩手 task 注入上一场摘要（接着辩、不重复）。
    seed = tool._prior_seed
    tasks_raw = [
        debater_task(config, side, idx, round_no=1, focus=focus, seed=seed)
        for idx, side in enumerate(sides)
    ]
    valid_tools = {s.name for s in tool._tools.list_all()}
    plan, errors = build_run_plan(
        tasks_raw,
        valid_tools=valid_tools,
        id_prefix=f"{moderator_run_id}_r1",
        parent_run_id=moderator_run_id,
        depth=tool._depth + 2,
    )
    if errors or not plan.nodes:
        logger.warning("debate.round1.build_failed", errors=errors)
        return [failed_turn(side, f"{moderator_run_id}_r1_{side.key}") for side in sides]

    # run_id 命名统一：首轮辩手改用语义后缀 `_r1_{side.key}`，与后续轮 continue_run 的
    # `_r{n}_{side.key}` 同构（旧法用 build_run_plan 给扁平批的位置序号 `_r1_1`，与后续轮
    # 漂移）。纯展示口径统一、零行为变化：血缘不靠 run_id 解析（续写经 session.run_id 显式
    # 带 parent_run_id 链回原始 run），key 已由 _parse_sides 保证非空且唯一，sides 与
    # plan.nodes 按声明序一一对应（与下方留人 zip 同前提）。首轮无 depends_on（扁平批），
    # 重命名无内部边需改。这也让真实产物对齐 conformance 向量记载的 `_r1_pro` 契约。
    plan.nodes = [
        replace(
            node,
            run_id=f"{moderator_run_id}_r1_{side.key}",
            agent_id=f"{moderator_run_id}_r1_{side.key}",
        )
        for side, node in zip(sides, plan.nodes, strict=False)
    ]

    tool._sink.emit(debater_plan_event(tool, execution_id, moderator_run_id, plan))
    worker_gate = (
        tool._approval_gate if tool._base_tool_context.backend.location == "local" else None
    )
    executor = build_agent_executor(
        plan=plan,
        llm=tool._llm,
        tools=tool._tools,
        sink=tool._sink,
        base_tool_context=tool._base_tool_context,
        profile_set=tool._profile_set,
        system_prompt=tool._system_prompt,
        user_message=tool._user_message,
        execution_id=execution_id,
        approval_gate=worker_gate,
    )
    scheduler = WaveScheduler(tool._max_parallel or DEFAULT_MAX_PARALLEL)
    batch_metrics: list[BatchMetrics] = []
    results = await scheduler.run(plan, executor, metrics_sink=batch_metrics)
    if batch_metrics:
        # 调度埋点量化: the debaters fan out as one parallel wave per round — same
        # batch-health read as delegate (avg_parallelism = busy/wall, slot_starved).
        m = batch_metrics[0]
        logger.info(
            "debate.round1.completed",
            nodes=m.nodes,
            width=m.width,
            peak=m.peak_running,
            wall_ms=m.wall_ms,
            busy_ms=m.busy_ms,
            avg_parallelism=round(m.busy_ms / m.wall_ms, 2) if m.wall_ms else 0.0,
            slot_starved=m.slot_starved,
            completed=m.completed,
            failed=m.failed,
            skipped=m.skipped,
        )

    turns: list[SideTurn] = []
    for side, node in zip(sides, plan.nodes, strict=False):
        state = results.get(node.run_id)
        if state is not None:
            tool._acc.add_run(node, state, parent_run_id=moderator_run_id)
        if state and state.phase is RunPhase.COMPLETED and state.content.strip():
            tool._debater_sessions[side.key] = RunSession(
                run_id=node.run_id,
                spec=node,
                transcript=state.transcript,
                content=state.content,
            )
            turns.append(SideTurn(side.key, side.name, node.run_id, state.content, ok=True))
        else:
            turns.append(failed_turn(side, node.run_id))
    return turns


async def next_round(
    tool: DebateTool,
    execution_id: str,
    moderator_run_id: str,
    config: DebateConfig,
    round_no: int,
    focus: str,
    sides,
    history,
    interjections=(),
) -> list[SideTurn]:
    """后续轮：各辩手【并行】continue_run 续写（注入对方上轮论点），收齐后按序留人 + 折算。

    与首轮一致地并发派各方（受 ``max_parallel`` 约束）：各方续写各自独立 session、本轮
    feedback 只取上一轮对方论点、互不依赖，故可并发——根治旧法「后续轮逐个 await，墙钟随
    方数线性叠加」。账目 / 留人 / SideTurn 在 gather 收齐后按 ``sides`` 顺序串行回写，与
    串行版的落账次序完全一致（并发只发生在 LLM 调用本身，不碰共享态）。
    """
    from agentcore.runtime.runs import DEFAULT_MAX_PARALLEL, RunPhase, continue_run

    sides = list(sides)
    last_round: RoundResult = history[-1]
    worker_gate = (
        tool._approval_gate if tool._base_tool_context.backend.location == "local" else None
    )
    semaphore = asyncio.Semaphore(tool._max_parallel or DEFAULT_MAX_PARALLEL)

    async def _continue_side(side: DebateSide):
        session = tool._debater_sessions.get(side.key)
        if session is None:
            return None
        revision_run_id = f"{moderator_run_id}_r{round_no}_{side.key}"
        feedback = round_feedback(config, side, round_no, focus, last_round, interjections)
        async with semaphore:
            return await continue_run(
                session=session,
                feedback=feedback,
                revision_run_id=revision_run_id,
                llm=tool._llm,
                tools=tool._tools,
                sink=tool._sink,
                base_tool_context=tool._base_tool_context,
                execution_id=execution_id,
                profile_set=tool._profile_set,
                approval_gate=worker_gate,
            )

    states = await asyncio.gather(*(_continue_side(side) for side in sides))

    turns: list[SideTurn] = []
    for side, state in zip(sides, states, strict=False):
        session = tool._debater_sessions.get(side.key)
        revision_run_id = f"{moderator_run_id}_r{round_no}_{side.key}"
        if session is None or state is None:
            turns.append(failed_turn(side, revision_run_id))
            continue
        rev_spec = replace(session.spec, run_id=revision_run_id, agent_id=revision_run_id)
        tool._acc.add_run(rev_spec, state, parent_run_id=moderator_run_id)
        if state.phase is RunPhase.COMPLETED and state.content.strip():
            # 续写成功：把延展后的 transcript 提交回 session，供下一轮再续写。
            session.transcript = state.transcript
            session.content = state.content
            session.recall_count += 1
            turns.append(SideTurn(side.key, side.name, revision_run_id, state.content, ok=True))
        else:
            turns.append(failed_turn(side, revision_run_id))
    return turns


def debater_plan_event(tool: DebateTool, execution_id: str, moderator_run_id: str, plan):
    """声明本轮辩手节点（parent=主持人）。前端 dedupe 跨轮重复声明。"""
    from agentcore.tools.builtin.debate.events import run_payload, side_card

    agents = [side_card(tool, n) for n in plan.nodes]
    runs = [run_payload(n) for n in plan.nodes]
    from agentcore.runtime.events import run_plan

    return run_plan(
        execution_id=execution_id,
        plan_type="debate",
        task_summary="",
        agents=agents,
        runs=runs,
    )
