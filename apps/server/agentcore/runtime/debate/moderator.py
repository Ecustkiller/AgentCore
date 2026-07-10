"""Moderator —— 主持人辩论循环（辩论编排设计.md §二 支点）。

主持人是「主持 + 裁判 + 书记」三合一的有状态编排角色，不是独立执行引擎：每轮循环四步——

1. **定本轮议题**（:meth:`_frame`）：首轮拆用户问题为争议焦点；后续轮基于上轮未决分歧设焦点。
2. **派各方发言**（注入的 :class:`~agentcore.runtime.debate.types.RoundRunner`）：一波并行辩手，
   底层复用 ``build_agent_executor`` / ``continue_run``（辩手跨轮带记忆）——本类不关心怎么派。
3. **裁判 + 写小结**（:meth:`_judge_and_summarize`）：一次结构化调用同时产出交锋质量与收敛判定
   （真交锋？还在产生新论点？可收场？）与本轮小结——二者读同一份发言，合并去掉冗余 round-trip
   （辩论编排设计.md §二：真去重、非节流补丁）。
4. **决策下一步**（:meth:`run` 循环体）：裁判判收敛 → 出简报收场；否则进下一轮 / 触安全上限兜底。

裁判 / 小结 / 简报 / 定议题都走 ``provider.complete`` 出结构化 JSON + 坏 JSON 容错（借鉴
``evals/judge.py``）；单测注入返回脚本化 JSON 的 fake provider，零成本验证循环 / 收敛 / 双产物。

实现按职责拆到同包子模块（纯结构，公开调用面不变）：

- :mod:`moderator_common` —— 截断 / JSON 容错 / prompt 块
- :mod:`moderator_agenda` —— 定议题 / 质询 / 结辩门槛
- :mod:`moderator_judge` —— 裁判 + 小结 + 记分
- :mod:`moderator_brief` —— 收场简报

→ 见设计: docs/03-AI核心/辩论编排设计.md §二、§四、§五
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from typing import Any

from agentcore.llm.provider.protocol import LLMMessage, LLMProvider, LLMRequest, TokenUsage
from agentcore.runtime.debate.moderator_agenda import (
    _CROSS_EXAM_SYSTEM,
    closing_enabled,
    cross_exam_enabled,
    cross_exam_questions,
    frame_round,
)
from agentcore.runtime.debate.moderator_brief import _BRIEF_SYSTEM, build_brief
from agentcore.runtime.debate.moderator_common import (
    RoundBoundaryHook,
    RoundHook,
    RoundStartHook,
    _parse_json_object,
)
from agentcore.runtime.debate.moderator_judge import _ASSESS_SYSTEM, judge_and_summarize
from agentcore.runtime.debate.types import (
    STOP_ALL_FAILED,
    STOP_CONVERGED,
    STOP_MAX_ROUNDS,
    STOP_REASONS,
    STOP_USER_CONCLUDED,
    ClosingRunner,
    ClosingStatement,
    CrossExamExchange,
    CrossExamRunner,
    DebateBrief,
    DebateConfig,
    DebateResult,
    DebateSeed,
    JudgeVerdict,
    RoundDecision,
    RoundResult,
    RoundRunner,
    SideTurn,
    UserInterjection,
)

# 单测契约：test_debate_evidence 从本模块 import 系统 prompt 常量。
__all__ = [
    "Moderator",
    "RoundHook",
    "RoundStartHook",
    "RoundBoundaryHook",
    "_ASSESS_SYSTEM",
    "_BRIEF_SYSTEM",
    "_CROSS_EXAM_SYSTEM",
]


class Moderator:
    """主持人辩论循环（辩论编排设计.md §二）。

    ``provider`` 注入便于单测（返回脚本化 JSON 的 fake）；``model`` 是裁判 / 小结 / 简报等
    主持人内部 LLM 调用所用模型（DebateTool 传该回合质量档的 strong 档）。``run`` 接收一个
    :class:`RoundRunner` 注入「怎么派一轮辩手」，本类只负责编排与判定。
    """

    def __init__(
        self, *, provider: LLMProvider, model: str, scenario_prefix: str = "debate"
    ) -> None:
        self._llm = provider
        self._model = model
        self._scenario = scenario_prefix
        # 主持人自身 LLM 调用（议题 / 裁判 / 小结 / 简报）的累计用量与轮数，供 DebateTool
        # 折算成主持人节点的一条 ledger 行（与辩手 run 一样计入回合总账）。
        self._usage = TokenUsage()
        self._llm_rounds = 0

    @property
    def usage(self) -> TokenUsage:
        """主持人自身 LLM 调用的累计 token 用量（DebateTool 据此计主持人节点账目）。"""
        return self._usage

    @property
    def llm_rounds(self) -> int:
        """主持人发起的 LLM 调用次数（议题 + 裁判 + 小结 + 简报）。"""
        return self._llm_rounds

    async def run(
        self,
        config: DebateConfig,
        *,
        run_round: RoundRunner,
        run_cross_exam: CrossExamRunner | None = None,
        run_closing: ClosingRunner | None = None,
        on_round_start: RoundStartHook | None = None,
        on_round: RoundHook | None = None,
        on_round_boundary: RoundBoundaryHook | None = None,
        seed: DebateSeed | None = None,
    ) -> DebateResult:
        """驱动整场辩论到收敛 / 上限，返回双产物（决策简报 + 交锋叙事线）。

        收敛【默认完全由裁判逐轮自判】（``verdict.converged`` 即收场）——无最小轮门槛强制多轮。
        「别过早收敛」的智慧在裁判标准里（:meth:`_judge_and_summarize`：第 1 轮开场默认继续、
        除非命题空泛），不再靠外部计数。``policy.max_rounds`` 是纯安全上限（裁判持续不收敛时的
        断路器兜底）。每轮成功产出后触发 ``on_round``（emit 事件 / 老板检查点）。

        交互式逐轮（opt-in，辩论编排设计.md §逐轮交互）：当注入 ``on_round_boundary`` 时，每轮
        判完 + 小结后把决定权交给用户而非直接采信裁判——``CONTINUE`` 再辩一轮（可带「加角度」焦点
        覆写）、``CONCLUDE`` 立即出结论（即便裁判判收敛也以用户为准；反之用户也可在裁判判收敛时续
        辩）。钩子返回 ``None``（超时 / 无活跃用户）则回退到裁判自动收敛。未接钩子时循环逐字不变
        （与 ``checkpoint`` marker 无 hook 即惰性同辙），故非交互辩论零行为变化。``max_rounds`` 始
        终是硬上限：用户连续 ``CONTINUE`` 也不会越过它。

        结构化补轮（可逆叫停·B，辩论编排设计.md §6.6）：``seed`` 非空时本场是
        【续辩】——:meth:`_frame` 让焦点正交于上一场已谈焦点（不重复），首个新轮辩手 task 注入上一场
        摘要（由 ``run_round`` 实现读取，见 ``rounds.first_round``），从「读懂上一场」处接着
        往深里辩。``None``（全新辩论）时逐字不变。

        质询回合（P1，辩论编排设计.md §4-2.1）：注入 ``run_cross_exam`` 且【认真辩透 + 对抗形态】
        （:meth:`_cross_exam_enabled`）时，每轮立论后插入一个【质询 beat】——主持人据立论生成定向各方
        的必答质询（:meth:`_cross_exam_questions`），被质询方经 runner 用 ``continue_run`` 正面作答，
        问答喂进裁判【记分】（P2，:meth:`_judge_and_summarize`）。未注入 / 快速对碰 / 圆桌时跳过，
        循环逐字回退到「立论→裁判」，零行为变化。

        结辩收束（P4·阶段化发言角色，辩论编排设计.md §4-2.4）：注入 ``run_closing`` 且【认真辩透 +
        对抗形态】（:meth:`_closing_enabled`）且本场确有有效发言时，收场（循环结束）后、简报前插入一个
        【结辩 beat】——各方经 runner 用 ``continue_run`` 在自己 transcript 上做一段收尾陈词（只讲胜负手、
        不引入新论据、长度收紧），随 :class:`ClosingStatement` 进 ``DebateResult.closings``。这是辩手自己的
        advocacy 收尾，与裁判中立的 ``brief`` 正交并存（真人辩论：结辩 + 裁决并存）。未注入 / 快速对碰 /
        圆桌 / 全员失败时跳过，收场后逐字回退到「直接出简报」，零行为变化。
        """
        rounds: list[RoundResult] = []
        stop_reason = STOP_MAX_ROUNDS  # 循环跑满未 break ⇒ 触上限兜底
        # 主持人开场白（第 1 轮 _frame 顺带产出，全场只取一次）：供前端顶部「会说话的主持人」气泡。
        opening = ""
        # 交互式「加角度」：用户在上一轮边界给的下一轮焦点覆写（空=主持人自动定焦点）。
        focus_override = ""
        # 交互式「追问」：用户在上一轮边界注入、待【本轮】辩手正面回应的问题（消费后清空）。
        pending_interjections: list[UserInterjection] = []
        for round_no in range(1, config.policy.max_rounds + 1):
            if focus_override:
                focus = focus_override
            else:
                focus, framed_opening = await self._frame(config, rounds, seed=seed)
                # 首轮 _frame 顺带产出开场白（后续轮为空）；全场只认第一句，不被后续覆盖。
                if framed_opening and not opening:
                    opening = framed_opening
            focus_override = ""
            interjections = pending_interjections
            pending_interjections = []
            # 焦点既定、发言之前先报本轮开场（前端据此亮出焦点头，再流式各方发言）。
            if on_round_start is not None:
                await on_round_start(round_no, focus)
            turns = list(
                await run_round(
                    round_no=round_no,
                    focus=focus,
                    sides=config.sides,
                    history=rounds,
                    interjections=interjections,
                )
            )
            # 追问被本轮承接（无论发言成败，本轮确已带着它跑过）⇒ 标记 answered，随本轮留痕复盘。
            answered = [replace(i, answered=True) for i in interjections]
            if not any(t.ok for t in turns):
                # 全员失败：无可裁判内容，主持人提前终止并出降级简报（别假装辩成了）。
                verdict = JudgeVerdict(
                    real_clash=False,
                    new_arguments=False,
                    converged=True,
                    stop_reason=STOP_ALL_FAILED,
                    rationale="本轮所有辩手均未产出有效发言。",
                )
                rr = RoundResult(
                    round_no,
                    focus,
                    turns,
                    verdict,
                    summary="本轮各方均未产出有效发言，辩论提前终止。",
                    user_interjections=answered,
                )
                rounds.append(rr)
                if on_round is not None:
                    await on_round(rr)
                stop_reason = STOP_ALL_FAILED
                break

            # 质询 beat（质询回合 P1，opt-in：注入 runner + 认真辩透 + 对抗形态才开）：主持人据本轮
            # 立论生成定向各方的必答质询，被质询方 continue_run 正面作答，喂进下方裁判记分。未开启恒空。
            cross_exam: list[CrossExamExchange] = []
            if run_cross_exam is not None and self._cross_exam_enabled(config):
                questions = await self._cross_exam_questions(config, focus, turns)
                if questions:
                    cross_exam = list(
                        await run_cross_exam(
                            round_no=round_no,
                            focus=focus,
                            sides=config.sides,
                            turns=turns,
                            questions=questions,
                        )
                    )

            # rounds 此刻是【已完成的历史轮】（本轮 rr 尚未 append）——喂给合并裁判作上一轮小结锚点。
            # 裁判判定 + 本轮小结 + 记分读同一份发言（含质询问答），合并成一次结构化调用去冗余（§二）。
            verdict, summary = await self._judge_and_summarize(
                config, focus, turns, rounds, cross_exam=cross_exam
            )
            rr = RoundResult(
                round_no,
                focus,
                turns,
                verdict,
                summary,
                user_interjections=answered,
                cross_exam=cross_exam,
            )
            rounds.append(rr)
            if on_round is not None:
                await on_round(rr)

            # 交互式逐轮边界（opt-in）：把「继续辩 / 加角度 / 够了出结论」交给用户；钩子返回 None
            # （超时 / 无活跃用户）则回退裁判自动收敛。用户选择凌驾裁判——CONCLUDE 即便裁判未收敛
            # 也收场，CONTINUE 即便裁判已收敛也续辩（focus 非空则覆写下一轮议题=「加角度」）。
            if on_round_boundary is not None:
                boundary = await on_round_boundary(
                    round_no=round_no,
                    result=rr,
                    converged=verdict.converged,
                    max_rounds=config.policy.max_rounds,
                )
                if boundary is not None:
                    if boundary.decision is RoundDecision.CONCLUDE:
                        stop_reason = STOP_USER_CONCLUDED
                        # 收场仍带追问 ⇒ 无后续轮可答，挂到本轮记为未应答（honest gap，别静默丢）。
                        if boundary.ask:
                            rr.user_interjections.append(
                                UserInterjection(
                                    ask=boundary.ask,
                                    target_key=boundary.ask_target,
                                    answered=False,
                                )
                            )
                        break
                    focus_override = boundary.focus  # CONTINUE：续辩（可带「加角度」焦点）
                    if boundary.ask:  # CONTINUE 带追问 ⇒ 待下一轮承接（消费时翻 answered）。
                        pending_interjections = [
                            UserInterjection(ask=boundary.ask, target_key=boundary.ask_target)
                        ]
                    continue

            if verdict.converged:
                stop_reason = (
                    verdict.stop_reason if verdict.stop_reason in STOP_REASONS else STOP_CONVERGED
                )
                break

        # 用户在轮数上限边界仍追问 CONTINUE 但已无后续轮承接 ⇒ 挂到最后一轮记未应答（别静默丢）。
        if pending_interjections and rounds:
            rounds[-1].user_interjections.extend(pending_interjections)

        # 结辩 beat（结辩收束 P4，opt-in：注入 runner + 认真辩透 + 对抗形态 + 本场确有有效发言才开）：
        # 收场后各方做收尾陈词（只讲胜负手、不引入新论据），随 closings 进 DebateResult。全员失败
        # （STOP_ALL_FAILED）无可收束的立场 ⇒ 跳过。未开启恒空，逐字回退到「直接出简报」。
        closings: list[ClosingStatement] = []
        if (
            run_closing is not None
            and self._closing_enabled(config)
            and stop_reason != STOP_ALL_FAILED
            and rounds
        ):
            closings = list(await run_closing(sides=config.sides, rounds=rounds))

        brief = await self._brief(config, rounds)
        return DebateResult(
            config=config,
            rounds=rounds,
            brief=brief,
            stop_reason=stop_reason,
            opening=opening,
            closings=closings,
        )

    # ── 第1步：定本轮议题 ────────────────────────────────────────────────
    async def _frame(
        self, config: DebateConfig, history: list[RoundResult], seed: DebateSeed | None = None
    ) -> tuple[str, str]:
        """定本轮议题焦点；第 1 轮附带一句主持人【开场白】。"""
        return await frame_round(self._complete_json, config, history, seed=seed)

    # ── 第2.5步：质询回合（质询回合 P1，辩论编排设计.md §4-2.1）──────────────
    @staticmethod
    def _cross_exam_enabled(config: DebateConfig) -> bool:
        """质询回合仅在【认真辩透 + 对抗形态】开启。"""
        return cross_exam_enabled(config)

    @staticmethod
    def _closing_enabled(config: DebateConfig) -> bool:
        """结辩收束（P4）仅在【认真辩透 + 对抗形态】开启。"""
        return closing_enabled(config)

    async def _cross_exam_questions(
        self, config: DebateConfig, focus: str, turns: Sequence[SideTurn]
    ) -> dict[str, list[str]]:
        """主持人代表交锋，据本轮立论为【每一方】生成 2–3 个必须正面回答的尖锐质询。"""
        return await cross_exam_questions(self._complete_json, config, focus, turns)

    # ── 第3+4步：裁判本轮 + 写本轮小结 + 记分（一次结构化调用）─────────────
    async def _judge_and_summarize(
        self,
        config: DebateConfig,
        focus: str,
        turns: Sequence[SideTurn],
        history: list[RoundResult],
        *,
        cross_exam: Sequence[CrossExamExchange] = (),
    ) -> tuple[JudgeVerdict, str]:
        """一次 LLM 调用同时产出【裁判判定】与【本轮小结】，返回 ``(verdict, summary)``。"""
        return await judge_and_summarize(
            self._complete_json, config, focus, turns, history, cross_exam=cross_exam
        )

    # ── 收场：决策简报（结论产物） ───────────────────────────────────────
    async def _brief(self, config: DebateConfig, rounds: list[RoundResult]) -> DebateBrief:
        return await build_brief(self._complete_json, config, rounds)

    async def _complete_json(self, system: str, user: str, step: str) -> dict[str, Any]:
        request = LLMRequest(
            messages=[
                LLMMessage(role="system", content=system),
                LLMMessage(role="user", content=user),
            ],
            model=self._model,
            temperature=0.0,
            stream=False,
            scenario=f"{self._scenario}.{step}",
        )
        response = await self._llm.complete(request)
        self._usage = self._usage + (response.usage or TokenUsage())
        self._llm_rounds += 1
        return _parse_json_object(response.content or "")
