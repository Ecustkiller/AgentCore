"""辩手轮次驱动：首轮并行派工 + 后续轮 continue_run。"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, replace
from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger
from agentcore.runtime.debate import (
    ClosingStatement,
    CrossExamExchange,
    DebateConfig,
    DebateSide,
    RoundResult,
    SideTurn,
)
from agentcore.runtime.debate.cross_exam_parse import (
    build_cross_exam_exchanges,
    parse_cross_exam_response,
)
from agentcore.runtime.events import batch_metrics as batch_metrics_event
from agentcore.tools.builtin.debate.prompt import (
    closing_context_blocks,
    closing_task,
    cx_answer_feedback,
    debater_task,
    round_context_blocks,
    round_feedback,
)

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
        # 辩手是对手不是协作团队：不配团队便签墙（否则正反方会经便签互读对方立论、面板还冒出
        # 莫名的「团队便签」）。跨方信息由主持人按轮喂 round_feedback，才是辩论正当的跨方通道。
        collaboration=False,
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
        # 深层诊断指标 (前端UX设计.md §十): also hand the scheduler snapshot to the client so
        # 诊断模式 shows the debaters' fan-out in run detail (journaled → replays on reload),
        # mirroring the delegate drive path. Whole-batch verbatim; the host already logged it.
        tool._sink.emit(batch_metrics_event(execution_id=execution_id, metrics=asdict(m)))

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
        # 收到的上下文 (上下文传递可视化): the display twin of `feedback` — 本轮焦点 / 对方上轮
        # 论点 / 被驳命门 / 追问 — from the SAME inputs, shipped as this round's run_context so
        # the revision node's panel shows what it was fed instead of the empty first-round task.
        context_blocks = round_context_blocks(
            config, side, round_no, focus, last_round, interjections
        )
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
                # 单一轮次投影: carry this side's TRUE round onto the revision's run_started
                # (辩论逐轮), so every fold reads 第几轮 from the wire, not the version number.
                round_no=round_no,
                context_blocks=context_blocks,
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


def make_cross_exam_runner(
    tool: DebateTool, execution_id: str, moderator_run_id: str, config: DebateConfig
):
    """质询回合（P1）的 :class:`~agentcore.runtime.debate.CrossExamRunner` 实现工厂。

    主持人已据本轮立论生成【定向各方的必答质询】（``questions``: side_key → 问题列表），本 runner 让每个
    被质询方用 ``continue_run`` 在【自己的 transcript】上正面作答（受 ``max_parallel`` 并发约束）：答复
    进入该方 session 记忆（下一轮立论续写可见）、折算进回合账目，返回各方 :class:`CrossExamExchange`
    （问答对喂回主持人裁判记分）。仅在主持人判定开启质询（认真辩透 + 对抗形态）时被调，与 :func:`next_round`
    共用同一批辩手 session。"""

    async def run_cross_exam(*, round_no, focus, sides, turns, questions):  # noqa: ANN001, ARG001
        from agentcore.runtime.runs import DEFAULT_MAX_PARALLEL, RunPhase, continue_run
        from agentcore.runtime.runs.types import ContextBlock

        sides_by_key = {s.key: s for s in sides}
        worker_gate = (
            tool._approval_gate if tool._base_tool_context.backend.location == "local" else None
        )
        semaphore = asyncio.Semaphore(tool._max_parallel or DEFAULT_MAX_PARALLEL)
        # 只质询「首轮已成功立论（有 session）+ 主持人给了问题」的方；顺序固定为 sides 声明序，账目 /
        # 留人回写次序一致（并发只发生在 continue_run 本身，不碰共享态，与 next_round 同辙）。
        targets = [
            (s.key, list(questions[s.key]))
            for s in sides
            if s.key in questions and questions[s.key] and s.key in tool._debater_sessions
        ]

        async def _answer(side_key: str, qs: list[str]):
            session = tool._debater_sessions.get(side_key)
            side = sides_by_key.get(side_key)
            if session is None or side is None:
                return None
            cx_run_id = f"{moderator_run_id}_r{round_no}_cx_{side_key}"
            feedback = cx_answer_feedback(config, side, round_no, focus, qs)
            # 收到的上下文（上下文传递可视化）：质询作答节点面板展示它被问了什么，而非空白 / 首轮任务。
            context_blocks = [
                ContextBlock(
                    channel="cross_exam",
                    heading=f"第 {round_no} 轮 · 质询（必须正面回答）",
                    body="\n".join(f"- {q}" for q in qs),
                )
            ]
            async with semaphore:
                return await continue_run(
                    session=session,
                    feedback=feedback,
                    revision_run_id=cx_run_id,
                    llm=tool._llm,
                    tools=tool._tools,
                    sink=tool._sink,
                    base_tool_context=tool._base_tool_context,
                    execution_id=execution_id,
                    profile_set=tool._profile_set,
                    approval_gate=worker_gate,
                    round_no=round_no,
                    context_blocks=context_blocks,
                )

        states = await asyncio.gather(*(_answer(k, qs) for k, qs in targets))

        exchanges: list[CrossExamExchange] = []
        for (side_key, qs), state in zip(targets, states, strict=False):
            cx_run_id = f"{moderator_run_id}_r{round_no}_cx_{side_key}"
            session = tool._debater_sessions.get(side_key)
            if session is None or state is None:
                exchanges.append(
                    CrossExamExchange(
                        target=side_key,
                        exchanges=build_cross_exam_exchanges(qs, "", overall_ok=False),
                        answer_run_id=cx_run_id,
                    )
                )
                continue
            rev_spec = replace(session.spec, run_id=cx_run_id, agent_id=cx_run_id)
            tool._acc.add_run(rev_spec, state, parent_run_id=moderator_run_id)
            if state.phase is RunPhase.COMPLETED and state.content.strip():
                # 作答成功：延展后的 transcript 提交回 session，下一轮立论续写在其之上（带质询记忆）。
                session.transcript = state.transcript
                session.content = state.content
                session.recall_count += 1
                qa_pairs = parse_cross_exam_response(qs, state.content, overall_ok=True)
                exchanges.append(
                    CrossExamExchange(
                        target=side_key,
                        exchanges=qa_pairs,
                        answer_run_id=cx_run_id,
                    )
                )
            else:
                exchanges.append(
                    CrossExamExchange(
                        target=side_key,
                        exchanges=build_cross_exam_exchanges(qs, "", overall_ok=False),
                        answer_run_id=cx_run_id,
                    )
                )
        return exchanges

    return run_cross_exam


def make_closing_runner(
    tool: DebateTool, execution_id: str, moderator_run_id: str, config: DebateConfig
):
    """结辩收束（阶段化发言角色 P4）的 :class:`~agentcore.runtime.debate.ClosingRunner` 实现工厂。

    辩论收场后主持人请各方做结辩：本 runner 让每个仍有 session 的方用 ``continue_run`` 在【自己的
    transcript】上出一段收尾陈词（受 ``max_parallel`` 并发约束，带全程记忆，只需给「只讲胜负手、不引入
    新论据」的 feedback，见 :func:`closing_task`），折算进账目，返回各方 :class:`ClosingStatement`（全文进
    该方 run 事件）。对称于 :func:`make_cross_exam_runner`，与逐轮辩手共用同一批 session；未成功立论 /
    无 session 的方不参与结辩（advocacy 收尾对失败方无意义）。仅在主持人判定开启结辩时被调。"""

    async def run_closing(*, sides, rounds):  # noqa: ANN001, ARG001
        from agentcore.runtime.runs import DEFAULT_MAX_PARALLEL, RunPhase, continue_run

        sides = list(sides)
        worker_gate = (
            tool._approval_gate if tool._base_tool_context.backend.location == "local" else None
        )
        semaphore = asyncio.Semaphore(tool._max_parallel or DEFAULT_MAX_PARALLEL)
        # 结辩 run 的逐轮标记沿用末轮号（结辩是收场收束、非新一轮）：让画布把结辩修订挂到该方末轮
        # 修订链尾，前端辩论视图仍按 run_id 直取结辩全文（与轮号解耦）。无轮次（理论不可达，防御）→ 0。
        final_round_no = rounds[-1].round_no if rounds else 0
        # 只让「已成功立论（有 session）」的方结辩，顺序固定为 sides 声明序（账目 / 留人回写次序一致，
        # 并发只发生在 continue_run 本身，与 next_round / cross_exam 同辙）。
        targets = [s for s in sides if s.key in tool._debater_sessions]

        async def _close(side: DebateSide):
            session = tool._debater_sessions.get(side.key)
            if session is None:
                return None
            closing_run_id = f"{moderator_run_id}_closing_{side.key}"
            feedback = closing_task(config, side)
            # 收到的上下文（上下文传递可视化）：结辩节点面板展示「请做结辩、只讲胜负手」定调，而非空白。
            context_blocks = closing_context_blocks(config, side)
            async with semaphore:
                return await continue_run(
                    session=session,
                    feedback=feedback,
                    revision_run_id=closing_run_id,
                    llm=tool._llm,
                    tools=tool._tools,
                    sink=tool._sink,
                    base_tool_context=tool._base_tool_context,
                    execution_id=execution_id,
                    profile_set=tool._profile_set,
                    approval_gate=worker_gate,
                    round_no=final_round_no,
                    context_blocks=context_blocks,
                )

        states = await asyncio.gather(*(_close(s) for s in targets))

        closings: list[ClosingStatement] = []
        for side, state in zip(targets, states, strict=False):
            closing_run_id = f"{moderator_run_id}_closing_{side.key}"
            session = tool._debater_sessions.get(side.key)
            if session is None or state is None:
                closings.append(
                    ClosingStatement(side.key, side.name, closing_run_id, ok=False)
                )
                continue
            rev_spec = replace(session.spec, run_id=closing_run_id, agent_id=closing_run_id)
            tool._acc.add_run(rev_spec, state, parent_run_id=moderator_run_id)
            if state.phase is RunPhase.COMPLETED and state.content.strip():
                # 结辩成功：延展后的 transcript 提交回 session（结辩是本方 transcript 的最后一段）。
                session.transcript = state.transcript
                session.content = state.content
                session.recall_count += 1
                closings.append(
                    ClosingStatement(
                        side.key,
                        side.name,
                        closing_run_id,
                        content=state.content,
                        ok=True,
                    )
                )
            else:
                closings.append(
                    ClosingStatement(side.key, side.name, closing_run_id, ok=False)
                )
        return closings

    return run_closing


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
