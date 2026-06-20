"""Moderator —— 主持人辩论循环（辩论编排设计.md §二 支点）。

主持人是「主持 + 裁判 + 书记」三合一的有状态编排角色，不是独立执行引擎：每轮循环五步——

1. **定本轮议题**（:meth:`_frame`）：首轮拆用户问题为争议焦点；后续轮基于上轮未决分歧设焦点。
2. **派各方发言**（注入的 :class:`~agentcore.runtime.debate.types.RoundRunner`）：一波并行辩手，
   底层复用 ``build_agent_executor`` / ``continue_run``（辩手跨轮带记忆）——本类不关心怎么派。
3. **裁判本轮**（:meth:`_judge`）：辩论领域内的交锋质量与收敛判定（真交锋？还在产生新论点？）。
4. **写本轮小结**（:meth:`_summarize`）：焦点 / 共识 / 分歧，过程产物「叙事线」的骨架。
5. **决策下一步**（:meth:`run` 循环体）：达最小轮门槛且收敛 → 出简报收场；否则进下一轮 / 触上限。

裁判 / 小结 / 简报 / 定议题都走 ``provider.complete`` 出结构化 JSON + 坏 JSON 容错（借鉴
``evals/judge.py``）；单测注入返回脚本化 JSON 的 fake provider，零成本验证循环 / 收敛 / 双产物。

→ 见设计: docs/03-AI核心/辩论编排设计.md §二、§四、§五
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.llm.protocol import LLMMessage, LLMProvider, LLMRequest, TokenUsage
from agentcore.runtime.debate.types import (
    STOP_ALL_FAILED,
    STOP_CONVERGED,
    STOP_MAX_ROUNDS,
    STOP_REASONS,
    DebateBrief,
    DebateConfig,
    DebateForm,
    DebateResult,
    JudgeVerdict,
    RoundResult,
    RoundRunner,
    SideTurn,
)

logger = get_logger(__name__)

# 单方发言喂进裁判 / 简报时的截断上限：裁判要看够内容才能判「真交锋」，但全文会爆 prompt。
# 头尾保留（_clip 取首尾各半），让发言的开场立论与收尾结论都留在视野里。
_TURN_CLIP = 3000
_SUMMARY_CLIP = 800

# 每轮完成后的回调（DebateTool 在此 emit 逐轮小结 SSE 事件 / 触发老板检查点；测试可省）。
RoundHook = Callable[[RoundResult], Awaitable[None]]
# 本轮焦点既定、辩手发言【前】的回调（DebateTool 据此 emit debate_round_started，让焦点先于
# 发言亮出）；入参 (round_no, focus)。测试可省。
RoundStartHook = Callable[[int, str], Awaitable[None]]


def _clip(text: str, limit: int = _TURN_CLIP) -> str:
    """头尾保留地截断 —— 长发言的立论（头）与结论（尾）都不丢，只挖空中段。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    half = max(1, (limit - 20) // 2)
    return f"{text[:half]}\n……（中段略）……\n{text[-half:]}"


def _parse_json_object(content: str) -> dict[str, Any]:
    """从 LLM 输出抽第一个 JSON 对象；坏 JSON 容错为 {}（调用方按场景降级）。"""
    try:
        start = content.index("{")
        end = content.rindex("}")
        data = json.loads(content[start : end + 1])
    except (ValueError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _as_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _as_str_list(value: Any) -> list[str]:
    """把 LLM 返回的列表字段规整为去空的字符串列表（容忍标量 / 混入非串元素）。"""
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str):
            s = item.strip()
        elif item is not None:
            s = str(item).strip()
        else:
            s = ""
        if s:
            out.append(s)
    return out


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "是", "y"}
    return default


def _form_guidance(form: DebateForm) -> str:
    """各形态的裁判 / 收敛判据差异（辩论编排设计.md §三表格）。"""
    if form is DebateForm.RED_TEAM:
        return (
            "形态=红队挑刺：红队单向攻击「被审方案」、方案方回应修补。收敛judge的重点是"
            "「风险是否已挖尽（无新风险可挖）」与「方案方是否已修补」，而非对称攻防。"
        )
    if form is DebateForm.ROUNDTABLE:
        return (
            "形态=多方圆桌：3+ 视角多边碰撞，无需对称攻防。收敛judge的重点是「观点光谱是否已"
            "铺满（不再冒出本质上的新视角）」，允许各方并非针锋相对。"
        )
    return (
        "形态=正反辩论：正反对称攻防。收敛judge的重点是「是否还有实质新论点」与「分歧是否已"
        "归结为价值/偏好之争（AI 判不了、该交用户）」。"
    )


def _sides_block(config: DebateConfig) -> str:
    lines = []
    for s in config.sides:
        tag = "（被审方案方）" if s.is_subject else ""
        lines.append(f"- {s.name}{tag}[{s.key}]：{s.stance}")
    return "\n".join(lines)


def _turns_block(turns: Sequence[SideTurn], *, clip: int = _TURN_CLIP) -> str:
    blocks = []
    for t in turns:
        if not t.ok:
            blocks.append(f"### {t.side_name}[{t.side_key}]\n（本轮未产出有效发言）")
            continue
        blocks.append(f"### {t.side_name}[{t.side_key}]\n{_clip(t.content, clip)}")
    return "\n\n".join(blocks)


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
        on_round_start: RoundStartHook | None = None,
        on_round: RoundHook | None = None,
    ) -> DebateResult:
        """驱动整场辩论到收敛 / 上限，返回双产物（决策简报 + 交锋叙事线）。

        循环把「最小轮门槛」叠在裁判的 ``converged`` 之上（防过早收敛，辩论编排设计.md §五）：
        即使裁判首轮就判收敛，也要跑满 ``policy.min_rounds`` 才允许收场；裁判持续不收敛则跑到
        ``policy.max_rounds`` 兜底停。每轮成功产出后触发 ``on_round``（emit 事件 / 老板检查点）。
        """
        rounds: list[RoundResult] = []
        stop_reason = STOP_MAX_ROUNDS  # 循环跑满未 break ⇒ 触上限兜底
        for round_no in range(1, config.policy.max_rounds + 1):
            focus = await self._frame(config, rounds)
            # 焦点既定、发言之前先报本轮开场（前端据此亮出焦点头，再流式各方发言）。
            if on_round_start is not None:
                await on_round_start(round_no, focus)
            turns = list(
                await run_round(
                    round_no=round_no, focus=focus, sides=config.sides, history=rounds
                )
            )
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
                )
                rounds.append(rr)
                if on_round is not None:
                    await on_round(rr)
                stop_reason = STOP_ALL_FAILED
                break

            verdict = await self._judge(config, focus, turns, rounds)
            summary = await self._summarize(config, focus, turns, verdict)
            rr = RoundResult(round_no, focus, turns, verdict, summary)
            rounds.append(rr)
            if on_round is not None:
                await on_round(rr)

            if round_no >= config.policy.min_rounds and verdict.converged:
                stop_reason = (
                    verdict.stop_reason if verdict.stop_reason in STOP_REASONS else STOP_CONVERGED
                )
                break

        brief = await self._brief(config, rounds)
        return DebateResult(config=config, rounds=rounds, brief=brief, stop_reason=stop_reason)

    # ── 第1步：定本轮议题 ────────────────────────────────────────────────
    async def _frame(self, config: DebateConfig, history: list[RoundResult]) -> str:
        if not history:
            user = (
                f"辩论命题：{config.motion}\n\n参与方：\n{_sides_block(config)}\n\n"
                f"{_form_guidance(config.form)}\n\n"
                "请把命题拆成【第一轮】各方应集中交锋的一个最核心争议焦点（一句话，具体可辩，"
                "不要泛泛）。只输出 JSON：{\"focus\": \"...\"}"
            )
        else:
            last = history[-1]
            user = (
                f"辩论命题：{config.motion}\n\n上一轮焦点：{last.focus}\n"
                f"上一轮小结：{_clip(last.summary, _SUMMARY_CLIP)}\n"
                f"裁判判定：真交锋={last.verdict.real_clash}、新论点={last.verdict.new_arguments}、"
                f"建议焦点={last.verdict.next_focus}\n\n"
                "请据上轮【仍未决的分歧】设【本轮】应聚焦的争议点（一句话，比上轮更深入，避免重复）。"
                "只输出 JSON：{\"focus\": \"...\"}"
            )
        data = await self._complete_json(_FRAME_SYSTEM, user, "frame")
        focus = _as_str(data.get("focus"))
        if focus:
            return focus
        # 容错：首轮用命题本身，后续用裁判建议焦点 / 上轮焦点兜底。
        if not history:
            return config.motion
        return history[-1].verdict.next_focus or history[-1].focus or config.motion

    # ── 第3步：裁判本轮 ──────────────────────────────────────────────────
    async def _judge(
        self,
        config: DebateConfig,
        focus: str,
        turns: Sequence[SideTurn],
        history: list[RoundResult],
    ) -> JudgeVerdict:
        round_no = len(history) + 1
        min_rounds = config.policy.min_rounds
        if round_no < min_rounds:
            gate_hint = "门槛未到，请如实判定但默认倾向继续（除非各方已明显重复）。"
        else:
            gate_hint = "门槛已到，可据实判收敛。"
        gate_note = f"注意：当前是第 {round_no} 轮，最小轮门槛为 {min_rounds} 轮。{gate_hint}"
        user = (
            f"辩论命题：{config.motion}\n本轮焦点：{focus}\n{_form_guidance(config.form)}\n{gate_note}\n\n"
            f"本轮各方发言：\n{_turns_block(turns)}\n\n"
            "请做【辩论领域内】的交锋质量与收敛判定（不是判谁写得好），只输出 JSON：\n"
            '{"real_clash": true/false, "new_arguments": true/false, "converged": true/false, '
            '"stop_reason": "converged|focus_clarified|red_team_exhausted", '
            '"next_focus": "若未收敛，下一轮应聚焦的点", "rationale": "一句话理由"}\n'
            "- real_clash：各方是否真针锋相对回应了彼此（而非各说各话）。\n"
            "- new_arguments：本轮是否还在产生【新】论点（开始重复=false）。\n"
            "- converged：是否可以收场（无新论点 / 焦点已澄清为价值之争 / 红队风险已挖尽）。"
        )
        data = await self._complete_json(_JUDGE_SYSTEM, user, "judge")
        if not data:
            # 坏 JSON 容错：保守地判「未收敛」（安全侧——宁可多辩一轮也不草草收场，呼应防过早收敛）。
            logger.warning("debate.judge.parse_failed", round_no=round_no)
            return JudgeVerdict(
                real_clash=True,
                new_arguments=True,
                converged=False,
                rationale="裁判输出无法解析，保守判未收敛。",
            )
        return JudgeVerdict(
            real_clash=_as_bool(data.get("real_clash"), True),
            new_arguments=_as_bool(data.get("new_arguments"), True),
            converged=_as_bool(data.get("converged"), False),
            stop_reason=_as_str(data.get("stop_reason")),
            next_focus=_as_str(data.get("next_focus")),
            rationale=_as_str(data.get("rationale")),
        )

    # ── 第4步：写本轮小结 ────────────────────────────────────────────────
    async def _summarize(
        self,
        config: DebateConfig,
        focus: str,
        turns: Sequence[SideTurn],
        verdict: JudgeVerdict,
    ) -> str:
        user = (
            f"辩论命题：{config.motion}\n本轮焦点：{focus}\n\n本轮各方发言：\n{_turns_block(turns)}\n\n"
            "请写一句【本轮小结】（≤80 字）：本轮交锋推进了什么、达成了什么共识、仍存什么分歧。"
            "面向速读者，串起认知推进线。只输出 JSON：{\"summary\": \"...\"}"
        )
        data = await self._complete_json(_SUMMARY_SYSTEM, user, "summary")
        summary = _as_str(data.get("summary"))
        return summary or verdict.rationale or "（本轮小结生成失败）"

    # ── 收场：决策简报（结论产物） ───────────────────────────────────────
    async def _brief(self, config: DebateConfig, rounds: list[RoundResult]) -> DebateBrief:
        if not rounds:
            return DebateBrief(
                crux=config.motion, recommendation="辩论未产生有效轮次，无法形成简报。"
            )
        timeline = "\n".join(
            f"第 {rr.round_no} 轮（{rr.focus}）：{_clip(rr.summary, _SUMMARY_CLIP)}"
            for rr in rounds
        )
        last_turns = _turns_block(rounds[-1].ok_turns, clip=_TURN_CLIP)
        sides_keys = ", ".join(s.key for s in config.sides)
        user = (
            f"辩论命题：{config.motion}\n参与方：\n{_sides_block(config)}\n\n"
            f"各轮推进：\n{timeline}\n\n最后一轮各方发言：\n{last_turns}\n\n"
            "请产出【决策简报】，为用户的决策负责到底（不要只把正反并排甩给他）。只输出 JSON：\n"
            "{\n"
            '  "crux": "双方真正的争议焦点在哪",\n'
            f'  "strongest_points": {{"<side_key∈[{sides_keys}]>": "该方去水后的最强论点"}},\n'
            '  "factual_disputes": ["关键【事实】分歧（可据证据帮判的）"],\n'
            '  "value_disputes": ["【价值/偏好】分歧（AI 判不了、必须交用户定的）"],\n'
            '  "leaning": "你的倾向性判断（基于事实哪方更站得住）",\n'
            '  "confidence": "置信度及其成立条件（说明在什么前提下倾向会反转）",\n'
            '  "recommendation": "给用户的具体建议",\n'
            '  "open_questions": ["仅剩需用户拍板的点"]\n'
            "}"
        )
        data = await self._complete_json(_BRIEF_SYSTEM, user, "brief")
        if not data:
            # 容错降级：用最后一轮小结拼一个最小简报，别让坏 JSON 吞掉整场结论。
            logger.warning("debate.brief.parse_failed", rounds=len(rounds))
            return DebateBrief(
                crux=rounds[0].focus or config.motion,
                recommendation=rounds[-1].summary or "简报生成失败，请查看逐轮交锋。",
            )
        return DebateBrief(
            crux=_as_str(data.get("crux")) or config.motion,
            strongest_points=_as_str_dict(data.get("strongest_points")),
            factual_disputes=_as_str_list(data.get("factual_disputes")),
            value_disputes=_as_str_list(data.get("value_disputes")),
            leaning=_as_str(data.get("leaning")),
            confidence=_as_str(data.get("confidence")),
            recommendation=_as_str(data.get("recommendation")),
            open_questions=_as_str_list(data.get("open_questions")),
        )

    async def _complete_json(self, system: str, user: str, step: str) -> dict[str, Any]:
        request = LLMRequest(
            messages=[
                LLMMessage(role="system", content=system),
                LLMMessage(role="user", content=user),
            ],
            model=self._model,
            temperature=0.0,
            stream=False,
            thinking=True,
            scenario=f"{self._scenario}.{step}",
        )
        response = await self._llm.complete(request)
        self._usage = self._usage + (response.usage or TokenUsage())
        self._llm_rounds += 1
        return _parse_json_object(response.content or "")


def _as_str_dict(value: Any) -> dict[str, str]:
    """把 strongest_points 规整为 {side_key: str}（容忍 LLM 返回 list[{key,point}] 等变体）。"""
    if isinstance(value, dict):
        return {str(k): _as_str(v) for k, v in value.items() if _as_str(v)}
    if isinstance(value, list):
        out: dict[str, str] = {}
        for item in value:
            if isinstance(item, dict):
                key = _as_str(item.get("key") or item.get("side") or item.get("side_key"))
                point = _as_str(item.get("point") or item.get("argument") or item.get("value"))
                if key and point:
                    out[key] = point
        return out
    return {}


_FRAME_SYSTEM = (
    "你是一场结构化辩论的主持人。你的职责之一是为每一轮设定一个【具体、可辩、不重复】的争议"
    "焦点，推动各方真正交锋而非各说各话。严格只输出要求的 JSON。"
)
_JUDGE_SYSTEM = (
    "你是一场结构化辩论的主持人兼裁判。你做的是【辩论领域内】的判定——是否真针锋相对、是否还在"
    "产生新论点、是否可以收场，而【不是】评价谁的文笔好。客观、严格，不因发言更长就认为更有料。"
    "严格只输出要求的 JSON。"
)
_SUMMARY_SYSTEM = (
    "你是一场结构化辩论的主持人兼书记。你为每一轮写一句精炼小结，串起整场的认知推进线，让速读者"
    "30 秒看懂辩论怎么演进。严格只输出要求的 JSON。"
)
_BRIEF_SYSTEM = (
    "你是一场结构化辩论的主持人。辩论收场时你产出【决策简报】，为用户的决策负责到底：去水提炼"
    "各方最强论点、区分【事实分歧】（可据证据帮判）与【价值/偏好分歧】（必须交用户定）、给出带"
    "置信度与成立条件的倾向判断。务实、诚实，不回避不确定性。严格只输出要求的 JSON。"
)
