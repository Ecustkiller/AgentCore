"""Moderator —— 主持人辩论循环（辩论编排设计.md §二 支点）。

主持人是「主持 + 裁判 + 书记」三合一的有状态编排角色，不是独立执行引擎：每轮循环五步——

1. **定本轮议题**（:meth:`_frame`）：首轮拆用户问题为争议焦点；后续轮基于上轮未决分歧设焦点。
2. **派各方发言**（注入的 :class:`~agentcore.runtime.debate.types.RoundRunner`）：一波并行辩手，
   底层复用 ``build_agent_executor`` / ``continue_run``（辩手跨轮带记忆）——本类不关心怎么派。
3. **裁判本轮**（:meth:`_judge`）：辩论领域内的交锋质量与收敛判定（真交锋？还在产生新论点？）。
4. **写本轮小结**（:meth:`_summarize`）：焦点 / 共识 / 分歧，过程产物「叙事线」的骨架。
5. **决策下一步**（:meth:`run` 循环体）：裁判判收敛 → 出简报收场；否则进下一轮 / 触安全上限兜底。

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
    STOP_USER_CONCLUDED,
    DebateBrief,
    DebateClash,
    DebateConfig,
    DebateForm,
    DebateResult,
    JudgeVerdict,
    RoundBoundary,
    RoundDecision,
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
# 交互式逐轮边界回调（opt-in，辩论编排设计.md §逐轮交互）：每轮判完 + 小结后，把「继续辩 / 加角
# 度 / 够了出结论」的决定权交给用户。入参 (round_no, result, converged, max_rounds)；返回
# :class:`RoundBoundary` 驱动循环，或 ``None`` 表示「交回裁判自动收敛」（DebateTool 在超时 / 无活
# 跃用户时返 None）。未接此钩子（默认 / 测试 / 非交互辩论）时循环逐字按裁判自判收敛，行为不变。
RoundBoundaryHook = Callable[..., Awaitable["RoundBoundary | None"]]


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


def _frame_form_hint(form: DebateForm) -> str:
    """各形态「该把本轮焦点定成什么」的差异指引（喂给 :meth:`Moderator._frame`）。

    与 :func:`_form_guidance`（裁判向：判收敛）正交——这条是议题向：定一个贴合形态、能逼出
    好交锋的焦点。圆桌尤其受益（要的是铺光谱的维度轴，而非二元对立）。"""
    if form is DebateForm.RED_TEAM:
        return (
            "形态=红队挑刺：把焦点对准【被审方案的一个具体风险面】（某失败场景 / 边界条件 / "
            "隐含假设的漏洞），让红队能集中火力施压、方案方能正面回应修补。"
        )
    if form is DebateForm.ROUNDTABLE:
        return (
            "形态=多方圆桌：把焦点定成一个能【摊开观点光谱】的维度轴——各方在此维度上自然分化、"
            "各有独特定位，而非逼出二元对立。好的圆桌焦点让每个视角都有独到的话可说。"
        )
    return (
        "形态=正反辩论：把焦点落在【真正分胜负的 crux】上——双方最根本的那个分歧点，"
        "而非双方其实都同意的外围枝节。"
    )


def _brief_form_hint(form: DebateForm) -> str:
    """各形态「简报该产出什么」的差异指引（喂给 :meth:`Moderator._brief`）。

    呼应 :attr:`DebateResult.narrative_first`：决策类（正反/红队）简报先行、为决策负责；
    探讨类（圆桌）过程先行、简报是观点地图小结。"""
    if form is DebateForm.RED_TEAM:
        return (
            "这是【红队挑刺】：简报应是【风险清单 + 加固建议】——把挖出的风险按严重度梳理、"
            "标明哪些方案方已修补、哪些仍是 open 风险需用户决断。"
        )
    if form is DebateForm.ROUNDTABLE:
        return (
            "这是【多方圆桌】：简报应是【观点地图小结】——铺出观点光谱全貌、各视角的独特定位与"
            "其成立前提，而非强行裁谁对谁错；末尾点出值得用户进一步思考的开放问题。"
        )
    return (
        "这是【正反辩论】：简报要为用户的【决策】负责到底——给出带置信度与反转条件的倾向判断 + "
        "具体建议，而非把正反并排甩给用户让他自己选。"
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
        on_round_boundary: RoundBoundaryHook | None = None,
    ) -> DebateResult:
        """驱动整场辩论到收敛 / 上限，返回双产物（决策简报 + 交锋叙事线）。

        收敛【默认完全由裁判逐轮自判】（``verdict.converged`` 即收场）——无最小轮门槛强制多轮。
        「别过早收敛」的智慧在裁判标准里（:meth:`_judge`：第 1 轮开场默认继续、除非命题空泛），
        不再靠外部计数。``policy.max_rounds`` 是纯安全上限（裁判持续不收敛时的断路器兜底）。每轮
        成功产出后触发 ``on_round``（emit 事件 / 老板检查点）。

        交互式逐轮（opt-in，辩论编排设计.md §逐轮交互）：当注入 ``on_round_boundary`` 时，每轮
        判完 + 小结后把决定权交给用户而非直接采信裁判——``CONTINUE`` 再辩一轮（可带「加角度」焦点
        覆写）、``CONCLUDE`` 立即出结论（即便裁判判收敛也以用户为准；反之用户也可在裁判判收敛时续
        辩）。钩子返回 ``None``（超时 / 无活跃用户）则回退到裁判自动收敛。未接钩子时循环逐字不变
        （与 ``checkpoint`` marker 无 hook 即惰性同辙），故非交互辩论零行为变化。``max_rounds`` 始
        终是硬上限：用户连续 ``CONTINUE`` 也不会越过它。
        """
        rounds: list[RoundResult] = []
        stop_reason = STOP_MAX_ROUNDS  # 循环跑满未 break ⇒ 触上限兜底
        # 交互式「加角度」：用户在上一轮边界给的下一轮焦点覆写（空=主持人自动定焦点）。
        focus_override = ""
        for round_no in range(1, config.policy.max_rounds + 1):
            focus = focus_override or await self._frame(config, rounds)
            focus_override = ""
            # 焦点既定、发言之前先报本轮开场（前端据此亮出焦点头，再流式各方发言）。
            if on_round_start is not None:
                await on_round_start(round_no, focus)
            turns = list(
                await run_round(round_no=round_no, focus=focus, sides=config.sides, history=rounds)
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
            # rounds 此刻是【已完成的历史轮】（本轮 rr 尚未 append）——喂给 _summarize 作上一轮锚点。
            summary = await self._summarize(config, focus, turns, verdict, rounds)
            rr = RoundResult(round_no, focus, turns, verdict, summary)
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
                        break
                    focus_override = boundary.focus  # CONTINUE：续辩（可带「加角度」焦点）
                    continue

            if verdict.converged:
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
                f"{_frame_form_hint(config.form)}\n\n"
                "请把命题拆成【第一轮】各方应集中交锋的一个最核心争议焦点——挑命题里【最承重】的"
                "那个争议点开场（分量最大、最能带出后续交锋的），别开在边角枝节上。"
                "焦点必须是【一句短语、不超过 30 字】、像一个小标题，聚焦【单一】具体可辩的争议点——"
                '不要复述命题、不要泛泛、不要用分号堆叠多个点。只输出 JSON：{"focus": "..."}'
            )
        else:
            last = history[-1]
            # 已覆盖焦点清单（全部历史轮，非仅上轮）：让主持人据【整场】已谈维度挑下一轮焦点，
            # 强制【正交】——根治「焦点换汤不换药 → 续写者输入几乎相同 → 输出相似」的冗余轮。
            covered = "\n".join(f"- 第 {rr.round_no} 轮：{rr.focus}" for rr in history)
            user = (
                f"辩论命题：{config.motion}\n\n已覆盖焦点（本轮须正交、勿换说法重谈）：\n{covered}\n\n"
                f"上一轮小结：{_clip(last.summary, _SUMMARY_CLIP)}\n"
                f"裁判判定：真交锋={last.verdict.real_clash}、新论点={last.verdict.new_arguments}、"
                f"建议焦点={last.verdict.next_focus}\n\n"
                f"{_frame_form_hint(config.form)}\n"
                "请据上轮【仍未决的分歧】设【本轮】应聚焦的争议点：必须【正交于上方已覆盖焦点】——"
                "换一个尚未谈透的维度或更深一层，而非换个说法重谈同一点。"
                "焦点必须是【一句短语、不超过 30 字】、像一个小标题，聚焦单一争议点。"
                '只输出 JSON：{"focus": "..."}'
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
        max_rounds = config.policy.max_rounds
        # clash 上限随参与方数放宽：2 方正反 4 条够，3+ 方圆桌要容得下跨对的交锋边（A驳B、C驳A），
        # 否则多方场景的交锋图被腰斩。仍设硬顶（_as_clashes 去重 + 截断），保叙事线轻量。
        clash_limit = max(4, len(config.sides) + 2)
        # 「别过早收敛」从机械楼层搬进裁判标准：第 1 轮开场各方往往尚未接火（real_clash=false
        # 是常态），默认继续以逼出下一轮交锋，仅当命题空泛到开场即无新论点才收；快速单轮模式
        # （max=1）本就一次对碰即收；多轮模式按 thorough 调收敛松紧。
        if max_rounds <= 1:
            gate_hint = "这是【快速单轮】：用户只想一次对碰即收，核心立场已亮出即可判【收敛】。"
        elif round_no == 1:
            gate_hint = (
                "这是第 1 轮（开场立论）：各方通常只是各自亮出立场、尚未真正接火（这正常），"
                "默认判【未收敛、继续】以逼出下一轮真交锋；【仅当】命题空泛到开场就无新论点、"
                "无可再辩时才判收敛。"
            )
        elif config.policy.thorough:
            gate_hint = "【认真辩透】：仍有新论点 / 未决的关键交锋时不要轻易收敛，挖尽实质分歧。"
        else:
            gate_hint = "核心交锋一旦清晰、无强未决分歧即可收敛，不必恋战。"
        gate_note = f"注意：当前是第 {round_no} 轮（安全上限 {max_rounds} 轮）。{gate_hint}"
        user = (
            f"辩论命题：{config.motion}\n本轮焦点：{focus}\n{_form_guidance(config.form)}\n{gate_note}\n\n"
            f"本轮各方发言：\n{_turns_block(turns)}\n\n"
            "请做【辩论领域内】的交锋质量与收敛判定（不是判谁写得好），只输出 JSON：\n"
            '{"real_clash": true/false, "new_arguments": true/false, "converged": true/false, '
            '"stop_reason": "converged|focus_clarified|red_team_exhausted", '
            '"next_focus": "若未收敛，下一轮应聚焦的点", '
            '"rationale": "一句话点出本轮的实质推进：谁让步 / 谁补强 / 谁被驳倒", '
            '"clashes": [{"from": "<side_key>", "to": "<被反驳方 side_key>", '
            '"point": "这条反驳的命门（一句话、锋利具体、抓住要害）"}]}\n'
            "- real_clash：各方是否真针锋相对回应了彼此（而非各说各话）。\n"
            "- new_arguments：本轮是否还在产生【新】论点（开始重复=false）。\n"
            "- converged：是否可以收场（无新论点 / 焦点已澄清为价值之争 / 红队风险已挖尽）。\n"
            "- rationale：别写空话套话，点出本轮交锋的【实质推进】（哪一方在哪个点上让步 / 补强 / "
            "被驳倒），让人一句话读懂本轮的胜负手。\n"
            f"- clashes：本轮谁【针对性反驳】了谁、驳的命门（只列真正针锋相对的边，各说各话别列；"
            f"要点一句话抓住要害、别复述原话）。**覆盖本轮主要交锋别遗漏**；多方时鼓励列出跨对的"
            f"边（如 A 驳 B、C 驳 A）。最多 {clash_limit} 条；from/to 用发言标题里的 [side_key]，"
            f"from≠to；本轮无真交锋则给 []。"
        )
        data = await self._complete_json(_JUDGE_SYSTEM, user, "judge")
        if not data:
            # 坏 JSON 容错：保守地判「未收敛」（安全侧——解析失败时宁可多辩一轮也不草草收场）。
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
            clashes=_as_clashes(
                data.get("clashes"), {s.key for s in config.sides}, limit=clash_limit
            ),
        )

    # ── 第4步：写本轮小结 ────────────────────────────────────────────────
    async def _summarize(
        self,
        config: DebateConfig,
        focus: str,
        turns: Sequence[SideTurn],
        verdict: JudgeVerdict,
        history: list[RoundResult],
    ) -> str:
        # 喂上一轮小结 → 本轮小结写成连贯的【认知推进线】（带 delta），而非孤立摘要。
        prev = _clip(history[-1].summary, _SUMMARY_CLIP) if history else ""
        prev_block = f"上一轮小结：{prev}\n\n" if prev else ""
        form_touch = (
            "（多方圆桌：侧重点出本轮【新增 / 凸显了哪个视角】、观点光谱往哪铺。）"
            if config.form is DebateForm.ROUNDTABLE
            else "（点出相比上一轮，本轮交锋【推进 / 澄清了什么】，与上轮串成一条推进线。）"
        )
        user = (
            f"辩论命题：{config.motion}\n本轮焦点：{focus}\n\n{prev_block}"
            f"本轮各方发言：\n{_turns_block(turns)}\n\n"
            "请写一句【本轮小结】（≤80 字）：本轮交锋推进了什么、达成了什么共识、仍存什么分歧。"
            f"{form_touch}面向速读者、串起认知推进线。"
            '只输出 JSON：{"summary": "..."}'
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
        is_red_team = config.form is DebateForm.RED_TEAM
        # 红队专用：让简报给每条风险（红队成员，不含被审方案方）评严重度，驱动前端「风险看板」
        # 分级 + 总览计数。其余形态不要这个字段（风险严重度对正反/圆桌无意义）。
        severity_field = (
            f'  "risk_severities": {{"<红队成员 side_key∈[{sides_keys}]>": "high|medium|low"}},\n'
            if is_red_team
            else ""
        )
        severity_note = (
            "（红队：在 risk_severities 里给每个红队成员的风险按【影响后果 × 发生可能性】评"
            "high/medium/low，让用户先看高危；被审方案方不评级。）"
            if is_red_team
            else ""
        )
        user = (
            f"辩论命题：{config.motion}\n参与方：\n{_sides_block(config)}\n\n"
            f"各轮推进：\n{timeline}\n\n最后一轮各方发言：\n{last_turns}\n\n"
            f"{_brief_form_hint(config.form)}\n"
            "请据此产出简报，为用户负责到底（不要只把各方观点并排甩给他）：各方最强论点要"
            "【去水压成单句、只留命门】、leaning / confidence 要写清【反转条件】（在什么前提下"
            f"倾向会翻）。{severity_note}只输出 JSON：\n"
            "{\n"
            '  "crux": "双方真正的争议焦点在哪",\n'
            f'  "strongest_points": {{"<side_key∈[{sides_keys}]>": "该方去水后的最强论点"}},\n'
            f"{severity_field}"
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
            # 严重度仅红队形态有意义：非红队即便 LLM 误填也丢弃，保证载荷干净。
            risk_severities=(
                _as_severity_dict(data.get("risk_severities")) if is_red_team else {}
            ),
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


def _as_clashes(value: Any, valid_keys: set[str], *, limit: int = 4) -> list[DebateClash]:
    """把裁判返回的 clashes 规整为校验过的 :class:`DebateClash` 列表（L3 谁驳谁）。

    防 LLM 幻觉：``from``/``to`` 必须命中真实 side_key、且 ``from≠to``、``point`` 非空；同一
    (from,to) 去重、整体截到 ``limit`` 条（保叙事线轻量）。容忍 ``from_key``/``to_key`` 别名。
    """
    if not isinstance(value, list):
        return []
    out: list[DebateClash] = []
    seen: set[tuple[str, str]] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        frm = _as_str(item.get("from") or item.get("from_key"))
        to = _as_str(item.get("to") or item.get("to_key"))
        point = _as_str(item.get("point") or item.get("rebuttal"))
        if frm not in valid_keys or to not in valid_keys or frm == to or not point:
            continue
        if (frm, to) in seen:
            continue
        seen.add((frm, to))
        out.append(DebateClash(from_key=frm, to_key=to, point=point))
        if len(out) >= limit:
            break
    return out


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


_SEVERITY_VALUES = {"high", "medium", "low"}
_SEVERITY_ALIASES = {
    "高": "high",
    "中": "medium",
    "低": "low",
    "critical": "high",
    "severe": "high",
    "major": "high",
    "moderate": "medium",
    "minor": "low",
}


def _as_severity_dict(value: Any) -> dict[str, str]:
    """把 risk_severities 规整为 {side_key: high|medium|low}（容忍中文/同义词/list 变体）。

    只收 high/medium/low 三档，非法档位丢弃——前端风险看板只认这三档分级。
    """

    def _norm(raw: Any) -> str:
        token = _as_str(raw).strip().lower()
        token = _SEVERITY_ALIASES.get(token, token)
        return token if token in _SEVERITY_VALUES else ""

    if isinstance(value, dict):
        out = {str(k): _norm(v) for k, v in value.items()}
        return {k: v for k, v in out.items() if v}
    if isinstance(value, list):
        result: dict[str, str] = {}
        for item in value:
            if isinstance(item, dict):
                key = _as_str(item.get("key") or item.get("side") or item.get("side_key"))
                sev = _norm(item.get("severity") or item.get("level") or item.get("value"))
                if key and sev:
                    result[key] = sev
        return result
    return {}


_FRAME_SYSTEM = (
    "你是一场结构化辩论的主持人。你的职责之一是为每一轮设定一个【具体、可辩、不重复】的争议"
    "焦点，推动各方真正交锋而非各说各话。焦点要精炼成【一句不超过 30 字的短语】、像一个小标题，"
    "而非完整长句或对命题的复述。严格只输出要求的 JSON。"
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
