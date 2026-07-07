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

→ 见设计: docs/03-AI核心/辩论编排设计.md §二、§四、§五
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.llm.provider.protocol import LLMMessage, LLMProvider, LLMRequest, TokenUsage
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
    DebateClash,
    DebateConfig,
    DebateForm,
    DebateResult,
    DebateSeed,
    JudgeVerdict,
    RoundBoundary,
    RoundDecision,
    RoundResult,
    RoundRunner,
    RoundScore,
    SideTurn,
    UserInterjection,
    tally_scores,
)

logger = get_logger(__name__)

# 单方发言喂进裁判 / 简报时的截断上限：裁判要看够内容才能判「真交锋」，但全文会爆 prompt。
# 头尾保留（_clip 取首尾各半），让发言的开场立论与收尾结论都留在视野里。
_TURN_CLIP = 3000
_SUMMARY_CLIP = 800
# 跨轮论点账本喂进裁判时的截断（收敛校准 §三 H2）：裁判本只看【当前轮】发言，看不见跨轮重复→
# 老论点换措辞被误判成新论点→永不因边际递减收敛（真实 trace 5 轮撞满 max_rounds 的根因）。喂前
# 几轮的紧凑账本让 new_arguments 能真正跨轮判；用已压缩的 summary/clashes、非全文，守 §二 token 预算。
_LEDGER_SUMMARY_CLIP = 300
_LEDGER_CLASHES_PER_ROUND = 4

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


def _prior_ledger(history: Sequence[RoundResult]) -> str:
    """把【前几轮】压成紧凑的「已辩论点账本」喂给裁判（收敛校准 §三 H2）。

    :meth:`Moderator._judge_and_summarize` 本只看【当前轮】发言，``history`` 只贡献 round_no 与
    小结锚点——故「跨轮重复」（老论点换个说法重述）对裁判不可见，会被误判成「还在产生新论点」而
    永不收敛。本账本把前几轮的 focus + 小结 + 交锋要点串成一份紧凑摘要（用已压缩的 summary /
    clashes、非全文，守 §二 token 预算），让裁判能判「本轮相比账本是否还有【跨轮】新论点」。

    只收有实质内容的轮（有小结或有交锋）——占位 / 空轮不入账本；无可入账内容时返回空串，裁判
    退化为只看当前轮（首轮天然如此）。
    """
    lines: list[str] = []
    for rr in history:
        summary = _clip(rr.summary, _LEDGER_SUMMARY_CLIP)
        clashes = rr.verdict.clashes[:_LEDGER_CLASHES_PER_ROUND]
        if not summary and not clashes:
            continue
        line = f"第 {rr.round_no} 轮（{rr.focus}）：{summary}"
        if clashes:
            edges = "；".join(f"{c.from_key}驳{c.to_key}「{c.point}」" for c in clashes)
            line += f"　[交锋：{edges}]"
        lines.append(line)
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        "【前几轮已辩论点账本】（判断本轮是否还有【跨轮】新论点用——账本里已有的论点，本轮换个"
        f"说法 / 换个例子重述都【不算】新论点）：\n{body}\n\n"
    )


def _interjections_block(rounds: Sequence[RoundResult]) -> str:
    """全场用户追问块（喂给 :meth:`Moderator._brief`）—— 把各轮承接的用户追问按轮汇总，让简报
    【交代是否已回应】（未应答的进 open_questions）。无追问返回空串（简报 prompt 不变、零变化）。"""
    items: list[str] = []
    for rr in rounds:
        for i in rr.user_interjections:
            target = f"（向 {i.target_key}）" if i.target_key else "（向全场）"
            state = "已在该轮请辩手回应" if i.answered else "未及回应"
            items.append(f"- 第 {rr.round_no} 轮{target}：{i.ask} — {state}")
    if not items:
        return ""
    body = "\n".join(items)
    return (
        "辩论过程中用户提出的【追问】（你的简报须交代是否已被回应；仍未答清的须进 "
        f"open_questions / recommendation，别让用户的问题石沉大海）：\n{body}\n\n"
    )


def _cross_exam_block(config: DebateConfig, cross_exam: Sequence[CrossExamExchange]) -> str:
    """把本轮质询问答渲染进裁判 prompt（记分裁判据此判「是否正面回应质询」，质询回合 P1）。

    每条 = 对某方的质询（问题列表）+ 该方回答（头尾裁剪防爆 prompt）；回答失败 / 未答如实标注，让裁判
    据「回避 / 答非所问」扣 engagement。无质询（未开启 / 全空）返回空串，裁判退化为只看立论、零变化。
    """
    if not cross_exam:
        return ""
    names = {s.key: s.name for s in config.sides}
    blocks: list[str] = []
    for cx in cross_exam:
        name = names.get(cx.target, cx.target)
        lines: list[str] = []
        for ex in cx.exchanges:
            ans = (
                _clip(ex.answer)
                if ex.ok and ex.answer.strip()
                else "（未正面作答 / 作答失败）"
            )
            lines.append(f"  Q: {ex.question}\n  A: {ans}")
        if not lines:
            continue
        qa = "\n".join(lines)
        blocks.append(f"### 对「{name}」的质询\n{qa}")
    body = "\n\n".join(blocks)
    return (
        "本轮【质询环节】问答（各方是否【正面】回答质询直接影响 engagement 记分——回避 / 答非所问 / "
        f"硬扛无据都要扣）：\n{body}\n\n"
    )


def _scores_block(config: DebateConfig, tally: dict[str, RoundScore]) -> str:
    """把全场累计记分渲染进简报 prompt（收场 decisive / leaning 据此，不拍脑袋；记分裁判 P2）。

    每方一行「论点+回应+证据 - 罚分 = 净分」+ 罚分事由。无记分（未开启 P2）返回空串（简报零变化）。
    """
    if not tally:
        return ""
    lines: list[str] = []
    for s in config.sides:
        sc = tally.get(s.key)
        if sc is None:
            continue
        pen = f"，罚 {len(sc.penalties)}（{'；'.join(sc.penalties)}）" if sc.penalties else ""
        lines.append(
            f"- {s.name}[{s.key}]：论点 {sc.argument} + 回应 {sc.engagement} + 证据 {sc.evidence}"
            f"{pen} = 净分 {sc.total}"
        )
    if not lines:
        return ""
    body = "\n".join(lines)
    return (
        "各方【累计记分】（裁判逐轮打分之和；你的 decisive / leaning 须与它一致——净分更高 / 罚分"
        f"更少的一方更站得住，相悖须说明为何）：\n{body}\n\n"
    )


# 第 1 轮【开场白】规格（喂给 :meth:`Moderator._frame` 的首轮分支）：主持人口吻的一句开场，供前端
# 顶部「会说话的主持人」气泡定调。空 / 解析失败时前端回落到模板开场白，故它是【锦上添花】而非硬依赖
# ——别为凑它牺牲 focus 质量。仅首轮产出（续辩首轮亦然），后续轮恒 ""（换轮点题由前端模板承担）。
_OPENING_SPEC = (
    "另外附一句【开场白】opening：用主持人的口吻、一句话（≤40 字）为整场定调——点出"
    "【这场要替用户定什么】＋【为什么先从这个焦点切入】。不复述命题原文、不剧透结论、不站队、"
    "不用寒暄套话。\n"
)


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
        """定本轮议题焦点；第 1 轮附带一句主持人【开场白】。

        返回 ``(focus, opening)``：``focus`` 是本轮争议焦点；``opening`` 仅【首轮】（全新辩论 /
        续辩首轮）产出——主持人口吻的一句开场，供前端顶部「会说话的主持人」气泡渲染（空 / 解析失败
        前端回落到模板开场白，故非硬依赖）。后续轮恒 ``""``（换轮点题由前端模板承担）。
        """
        # 结构化补轮·B：上一场已谈焦点（续辩须正交于它，不重复换说法重谈）。扁平 if/elif/else 避免
        # 嵌套加深缩进（否则全新辩论 prompt 行被推过 100 字超长）。
        prior_focuses = seed.covered_focuses if seed else []
        if not history and prior_focuses:
            # 续辩首轮：把上一场焦点列为「已覆盖」，逼出一个正交的新焦点（更深 / 换维度）。
            covered = "\n".join(f"- {f}" for f in prior_focuses)
            user = (
                f"辩论命题：{config.motion}\n\n这是【续辩】——上一场已覆盖这些焦点"
                f"（本场须正交、勿换说法重谈）：\n{covered}\n\n"
                f"参与方：\n{_sides_block(config)}\n\n{_frame_form_hint(config.form)}\n\n"
                "请为【本场第一轮】定一个【正交于已谈焦点】的争议点——换一个尚未谈透的"
                "维度或更深一层，把上一场辩论往前推。焦点须是【一句≤30 字短语】、像小标题，"
                "聚焦单一争议点、不复述命题。\n"
                f"{_OPENING_SPEC}"
                '只输出 JSON：{"focus": "...", "opening": "..."}'
            )
        elif not history:
            user = (
                f"辩论命题：{config.motion}\n\n参与方：\n{_sides_block(config)}\n\n"
                f"{_frame_form_hint(config.form)}\n\n"
                "请把命题拆成【第一轮】各方应集中交锋的一个最核心争议焦点——挑命题里【最承重】的"
                "那个争议点开场（分量最大、最能带出后续交锋的），别开在边角枝节上。"
                "焦点必须是【一句短语、不超过 30 字】、像一个小标题，聚焦【单一】具体可辩的争议点——"
                "不要复述命题、不要泛泛、不要用分号堆叠多个点。\n"
                f"{_OPENING_SPEC}"
                '只输出 JSON：{"focus": "...", "opening": "..."}'
            )
        else:
            last = history[-1]
            # 已谈焦点清单（全部历史轮，非仅上轮）：喂给主持人做「别换个说法重谈」的防重锚点——
            # 让它往深里钻决定性分歧，而非每轮硬换正交新维度（旧「强制正交」把决策辩论推满上限）。
            # 续辩时上一场焦点也并入清单，跨场也不重谈。
            covered_lines = [f"- （上一场）{f}" for f in prior_focuses]
            covered_lines += [f"- 第 {rr.round_no} 轮：{rr.focus}" for rr in history]
            covered = "\n".join(covered_lines)
            user = (
                f"辩论命题：{config.motion}\n\n已谈过的焦点（别换个说法重谈；往深推、或推进到下一个更决定结论的点）：\n{covered}\n\n"
                f"上一轮小结：{_clip(last.summary, _SUMMARY_CLIP)}\n"
                f"裁判判定：真交锋={last.verdict.real_clash}、新论点={last.verdict.new_arguments}、"
                f"建议焦点={last.verdict.next_focus}\n\n"
                f"{_frame_form_hint(config.form)}\n"
                "请据上一轮仍未决的分歧定【本轮】焦点，目标是【尽快把用户的决策推到能下结论】："
                "优先把真正决定结论的那个分歧【往深里逼、逼它见分晓】，别把上一轮换个说法重谈、"
                "也别急着铺开新枝节；只有当这个决定性分歧确已辩尽（被事实分出高下、或见底成价值"
                "选择）时，才转向下一个【最影响结论】的点。（多方圆桌例外：本就为铺光谱，可转新视角。）"
                "焦点必须是【一句短语、不超过 30 字】、像一个小标题，聚焦单一争议点。"
                '只输出 JSON：{"focus": "..."}'
            )
        data = await self._complete_json(_FRAME_SYSTEM, user, "frame")
        focus = _as_str(data.get("focus"))
        # opening 仅首轮 prompt 索取；后续轮 data 无此键 → ""（换轮点题走前端模板）。
        opening = _as_str(data.get("opening"))
        if focus:
            return focus, opening
        # 容错：首轮用命题本身，后续用裁判建议焦点 / 上轮焦点兜底。
        # opening 兜底为空（前端回落模板）。
        if not history:
            return config.motion, opening
        return history[-1].verdict.next_focus or history[-1].focus or config.motion, ""

    # ── 第2.5步：质询回合（质询回合 P1，辩论编排设计.md §4-2.1）──────────────
    @staticmethod
    def _cross_exam_enabled(config: DebateConfig) -> bool:
        """质询回合仅在【认真辩透 + 对抗形态】开启：快速对碰（单轮轻量、守延迟）与多方圆桌（不强求
        对立、无质询配对语义）跳过。与 :meth:`_judge_and_summarize` 的记分共命运——不开质询也能记分，
        但开了质询，回避 / 被戳穿才有据可扣（engagement）。"""
        return config.policy.thorough and config.form in (DebateForm.DEBATE, DebateForm.RED_TEAM)

    @staticmethod
    def _closing_enabled(config: DebateConfig) -> bool:
        """结辩收束（P4）仅在【认真辩透 + 对抗形态】开启——与 :meth:`_cross_exam_enabled` 同门槛：
        快速对碰守延迟（单轮轻量，加结辩得不偿失）、圆桌无「对垒收束」语义（各视角铺光谱、非争胜负）。
        对抗形态（正反辩论 / 红队）里，结辩是「辩已辩尽、各方最后亮胜负手」的自然收尾（真人辩论标配）。"""
        return config.policy.thorough and config.form in (DebateForm.DEBATE, DebateForm.RED_TEAM)

    async def _cross_exam_questions(
        self, config: DebateConfig, focus: str, turns: Sequence[SideTurn]
    ) -> dict[str, list[str]]:
        """主持人代表交锋，据本轮立论为【每一方】生成 2–3 个必须正面回答的尖锐质询。

        质询直指该方【最站不住 / 最缺证据 / 涉嫌谬误】的点（循环论证、拿未定论当已成立的论据、给不出
        出处的具体数字、回避对方命门），逼其正面回应——「让交锋当面发生」的落点。返回 ``{side_key:
        [问题, ...]}``，只保留命中真实 side_key 且非空的方，每方至多 3 问；坏 JSON / 全空返回 {}
        （循环据此跳过质询、零副作用）。用 ``scenario=…​.cross_exam`` 单列，与裁判 / 简报调用分开计费。
        """
        if not any(t.ok for t in turns):
            return {}
        valid_keys = {s.key for s in config.sides}
        user = (
            f"辩论命题：{config.motion}\n本轮焦点：{focus}\n{_form_guidance(config.form)}\n\n"
            f"本轮各方发言：\n{_turns_block(turns)}\n\n"
            "你是主持人，现在进入【质询环节】：代表交锋，为【每一方】拟 2–3 个【必须正面回答】的"
            "尖锐质询，直指该方本轮【最站不住脚 / 最缺证据 / 涉嫌逻辑谬误】的点——例如循环论证、拿"
            "尚无定论的东西当已成立的论据、给不出出处的具体数字 / 事实、回避了对方的命门。"
            "【举证责任】要盯紧：凡该方标了【待核实】却当决定性论据用、或给了具体数字/案号却【未标证据状态】"
            "（默认视为待核实）的主张，都要当面追问「这条你有出处吗？拿不出为何还当论据？」。问题要"
            "【具体、锋利、可被正面回答】（可用是 / 否逼答），别泛泛而问、别复述其发言。只输出一个 JSON：\n"
            f'{{"questions": {{"<side_key∈[{", ".join(sorted(valid_keys))}]>": ["质询1", "质询2"]}}}}'
        )
        data = await self._complete_json(_CROSS_EXAM_SYSTEM, user, "cross_exam")
        raw = data.get("questions")
        if not isinstance(raw, dict):
            return {}
        out: dict[str, list[str]] = {}
        for key, qs in raw.items():
            k = str(key)
            if k in valid_keys:
                questions = _as_str_list(qs)[:3]
                if questions:
                    out[k] = questions
        return out

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
        """一次 LLM 调用同时产出【裁判判定】与【本轮小结】，返回 ``(verdict, summary)``。

        二者读的是同一份本轮发言，背靠背两次 ``thinking`` 调用是冗余 round-trip（辩论编排设计.md §二：真去重、非节流补丁）。主持人本就是「裁判 + 书记」二合一角色（见类 docstring），
        合并成一遍推理天然贴合：裁判位判交锋质量与收敛、书记位写认知推进线小结。

        **裁判语义与拆分实现逐字不变**——gate_hint（首轮默认继续 / 快速单轮即收 / thorough 调松
        紧）、clash 上限、``stop_reason`` 归一（仅收敛有意义、非法回落 ``STOP_CONVERGED``）、坏 JSON
        保守判未收敛全部保留；小结叠加上一轮锚点写成 delta 推进线，坏 JSON 时回落裁判 rationale。

        **跨轮论点账本（收敛校准 §三 H2）**：``history`` 除定 round_no / 小结锚点外，还经
        :func:`_prior_ledger` 压成【前几轮已辩论点账本】喂进裁判——让 ``new_arguments`` 能判「本轮
        相比前几轮是否还有【跨轮】新论点」（老论点换措辞重述=false），根治「只看当前轮→跨轮重复不
        可见→永不因边际递减收敛」。首轮 / 无实质前轮时账本空、退化为只看当前轮（行为同旧）。
        """
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
            gate_hint = (
                "【认真辩透】≠ 把每个角度都辩一遍。盯住【真正决定用户问题的那个分歧】往深里辩；"
                "一旦它要么被事实/逻辑分出高下、要么已见底成一个【只能由用户拍板的价值/偏好选择】，"
                "就判【收敛】——价值之争见底是收场信号，不是继续信号。仅当还能冒出【会改变结论】的"
                "实质新论点时才继续；只把旧分歧换个说法、或转去边角枝节，都应收敛。"
            )
        else:
            gate_hint = "核心交锋一旦清晰、无强未决分歧即可收敛，不必恋战。"
        gate_note = f"注意：当前是第 {round_no} 轮（安全上限 {max_rounds} 轮）。{gate_hint}"
        # 小结锚点：喂上一轮小结 → 本轮小结写成连贯的【认知推进线】（带 delta），而非孤立摘要。
        prev = _clip(history[-1].summary, _SUMMARY_CLIP) if history else ""
        prev_block = f"上一轮小结（供小结续写认知推进线）：{prev}\n\n" if prev else ""
        # 跨轮论点账本（收敛校准 §三 H2）：让裁判据前几轮已辩论点判「本轮是否还有跨轮新论点」，
        # 而非只看当前轮把老论点换措辞误判成新论点。首轮 / 无实质前轮时为空、裁判退化为只看本轮。
        ledger_block = _prior_ledger(history)
        summary_touch = (
            "（多方圆桌：侧重点出本轮【新增 / 凸显了哪个视角】、观点光谱往哪铺。）"
            if config.form is DebateForm.ROUNDTABLE
            else "（点出相比上一轮，本轮交锋【推进 / 澄清了什么】，与上轮串成一条推进线。）"
        )
        # 质询问答喂进裁判记分（回避 / 答非所问 → 扣 engagement）；未开启质询恒空块，记分退化为只看立论。
        cx_block = _cross_exam_block(config, cross_exam)
        sides_keys = ", ".join(s.key for s in config.sides)
        clash_note = (
            "- clashes：第 1 轮是开场立论——各方同时独立发言、互不知道对方说了什么，"
            "不可能存在「针对性反驳」，恒给 []。\n"
            if round_no == 1
            else (
                f"- clashes：本轮谁【针对性反驳】了谁、驳的命门（只列真正针锋相对的边，各说各话别列；"
                f"要点一句话抓住要害、别复述原话）。**覆盖本轮主要交锋别遗漏**；多方时鼓励列出跨对的"
                f"边（如 A 驳 B、C 驳 A）。最多 {clash_limit} 条；from/to 用发言标题里的 [side_key]，"
                f"from≠to；本轮无真交锋则给 []。\n"
            )
        )
        engagement_note = (
            "engagement 论点展开完整度"
            "（第 1 轮无对方可回应——改评论点展开是否完整、有无遗漏本应覆盖的核心论域）"
            if round_no == 1
            else "engagement 回应完整度"
            "（是否正面回应对方命门与【质询】、有无回避 / 答非所问 / drop 掉对方要害）"
        )
        user = (
            f"辩论命题：{config.motion}\n本轮焦点：{focus}\n{_form_guidance(config.form)}\n{gate_note}\n\n"
            f"{ledger_block}{prev_block}本轮各方发言：\n{_turns_block(turns)}\n\n{cx_block}"
            "请一次性完成三件事——① 做【辩论领域内】的交锋质量与收敛判定（不是判谁写得好）；"
            "② 写一句【本轮小结】；③ 给各方【本轮记分】（辩论领域内、不评文笔）。只输出一个 JSON：\n"
            '{"real_clash": true/false, "new_arguments": true/false, "converged": true/false, '
            '"stop_reason": "converged|focus_clarified|red_team_exhausted", '
            '"next_focus": "若未收敛，下一轮应聚焦的点", '
            '"rationale": "一句话点出本轮的实质推进：谁让步 / 谁补强 / 谁被驳倒", '
            '"clashes": [{"from": "<side_key>", "to": "<被反驳方 side_key>", '
            '"point": "这条反驳的命门（一句话、锋利具体、抓住要害）"}], '
            f'"scores": {{"<side_key∈[{sides_keys}]>": {{"argument": 0, "engagement": 0, '
            '"evidence": 0, "penalties": ["谬误/无据主张，一句话"], "note": "一句话记分理由"}}}, '
            '"summary": "本轮小结（≤80 字）"}\n'
            "- real_clash：各方是否真针锋相对回应了彼此（而非各说各话）。\n"
            "- new_arguments：本轮相比【前几轮已辩论点账本】是否还在产生【跨轮新论点】——把账本里"
            "已有的论点换措辞 / 换例子重述【不算】新论点（=false），只有出现账本里没有、且会推进交锋"
            "的论点才算 true；无账本（首轮）时看本轮是否亮出实质立论。\n"
            "- converged：是否可以收场（无新论点 / 焦点已澄清为价值之争 / 红队风险已挖尽）。\n"
            "- rationale：别写空话套话，点出本轮交锋的【实质推进】（哪一方在哪个点上让步 / 补强 / "
            "被驳倒），并点明【真正的分歧现在收窄到哪个决定性点，或已见底成哪个价值选择】，"
            "让人一句话读懂本轮的胜负手与还剩什么待决。\n"
            f"{clash_note}"
            f"- scores：给每一方本轮打分（各项 0–5 整数）：argument 论点强度、{engagement_note}、evidence 证据"
            "充分度——据【举证责任】判，且对【已核实】的出处再分【来源等级】：关键事实标【已核实·出处】"
            "且出处是【一手 / 权威源】（判决书 / 官方公告 / 一手档案 / 原始数据 / 财报）= 证据强、可给满；"
            "但一条【决定性事实】只靠【单一二手来源】（媒体转载 / 二手报道）撑着时，即便标了【已核实】"
            "也只算【弱证据】、evidence 封顶打低——除非有【多源交叉印证】才回补；关键事实标【待核实】或"
            "【未标证据状态】（默认视为待核实）却撑着结论 = 证据弱、evidence 打低；"
            "penalties 列本轮的【逻辑谬误】（循环论证 / 稻草人 / 诉诸情绪…）与【无据硬拗】（把【待核实】/"
            "未标记的主张当成【已核实】的决定性论据、或臆造出处），每条一句话——circular 与无据硬拗【必须】"
            "计入、别手软；但【诚实标注待核实】本身【不是】罚项（只罚硬拗成事实，不罚诚实存疑）；"
            "note 一句话理由。记分只对【论证有效性 / 证据 / 是否回应】，不因发言更长 / 文采更好给高分。\n"
            f"- summary：本轮交锋推进了什么、达成了什么共识、仍存什么分歧。{summary_touch}"
            f"面向速读者、串起认知推进线。"
        )
        data = await self._complete_json(_ASSESS_SYSTEM, user, "assess")
        if not data:
            # 坏 JSON 容错：保守地判「未收敛」（安全侧——解析失败时宁可多辩一轮也不草草收场）；
            # 小结无从生成，回落裁判 rationale（与拆分时 _summarize 的兜底同口径）。
            logger.warning("debate.assess.parse_failed", round_no=round_no)
            verdict = JudgeVerdict(
                real_clash=True,
                new_arguments=True,
                converged=False,
                rationale="裁判输出无法解析，保守判未收敛。",
            )
            return verdict, verdict.rationale
        converged = _as_bool(data.get("converged"), False)
        # stop_reason 仅在【收敛】时有意义（见 JudgeVerdict 契约）：未收敛时强制留空，杜绝
        # 「converged=false 却带 stop_reason」的口径错位随本轮 verdict 流入 journal / 前端
        # （真实 trace 曾出现第 1 轮未收敛却标 focus_clarified）。收敛时校验取值落在词表内，
        # 否则回落 STOP_CONVERGED——与循环层归一（下方 verdict.converged 分支）同一口径。
        raw_stop = _as_str(data.get("stop_reason"))
        if converged:
            stop_reason = raw_stop if raw_stop in STOP_REASONS else STOP_CONVERGED
        else:
            stop_reason = ""
        side_keys = {s.key for s in config.sides}
        verdict = JudgeVerdict(
            real_clash=_as_bool(data.get("real_clash"), True),
            new_arguments=_as_bool(data.get("new_arguments"), True),
            converged=converged,
            stop_reason=stop_reason,
            next_focus=_as_str(data.get("next_focus")),
            rationale=_as_str(data.get("rationale")),
            clashes=_as_clashes(data.get("clashes"), side_keys, limit=clash_limit),
            # 记分裁判（P2）：缺省 / 坏 JSON → 空 dict（tally 据此退化、简报零变化）。
            scores=_as_scores(data.get("scores"), side_keys),
        )
        # 边际递减断路器（收敛校准 P1，辩论编排设计.md §五）：连续两轮都判不出【跨轮新论点】
        # ⇒ 交锋已进入复述、再打只是换措辞。即便裁判本轮仍给 converged=false 也机械收场——这落的正是
        # STOP_CONVERGED 的定义（「各方无实质新论点·开始重复」），用已有的 new_arguments 信号把该定义
        # 兑成一个【确定性下限】：与 max_rounds 硬上限同属断路器，但更早、更省（真实 trace 3–4 轮基本
        # 复述却硬打满）。只补下限、不改裁判语义（裁判本就该在此收敛，这里兜住其逐轮口径漂移）。首轮
        # history 空 → 恒不触发；交互式逐轮下用户仍可在边界 CONTINUE 覆写（续辩优先，见 run 循环）。
        if (
            not verdict.converged
            and not verdict.new_arguments
            and history
            and not history[-1].verdict.new_arguments
        ):
            verdict = replace(verdict, converged=True, stop_reason=STOP_CONVERGED)
            logger.info("debate.converge.diminishing_returns", round_no=round_no)
        summary = _as_str(data.get("summary")) or verdict.rationale or "（本轮小结生成失败）"
        return verdict, summary

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
        # 用户追问（交互式逐轮）：把全场用户注入的问题喂进简报，让结论【交代是否已回应】——未应答的
        # 追问应进 open_questions（仅剩需你拍板/查证的点），别让用户的问题石沉大海。无追问则省略。
        followups_block = _interjections_block(rounds)
        # 记分裁判（P2）：全场累计记分喂进简报，让 decisive / leaning 与实际交锋对齐（净分更高、罚分
        # 更少的一方更站得住），而非收场拍脑袋。无记分（未开启 P2）则空块，简报逐字回退、零变化。
        scores_block = _scores_block(config, tally_scores(rounds))
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
            f"各轮推进：\n{timeline}\n\n{scores_block}{followups_block}最后一轮各方发言：\n{last_turns}\n\n"
            f"{_brief_form_hint(config.form)}\n"
            "请据此产出简报，为用户负责到底（不要只把各方观点并排甩给他）：各方最强论点要"
            "【去水压成单句、只留命门】；若上方给了【累计记分】，你的 decisive / leaning 必须与它一致"
            "（净分更高 / 罚分更少的一方更站得住；若倾向与记分相悖须在 confidence 里说明为何）；"
            "leaning / confidence 还要写清【反转条件】（在什么前提下倾向会翻）。"
            "【关键事实的证据状态必须继承到结论、不得在收尾抹平】：若 decisive / leaning 依赖的某个"
            "关键事实在辩论里是【待核实】或仅【单一二手来源】，不得把它当既定事实来定倾向——要么在 "
            "confidence 里显式降级并标【需一手核实】，要么把它移进 factual_disputes / open_questions；"
            "结论文字里引用这类事实时【保留证据状态词】（如「若 X 属实——目前仅二手报道、待一手核实——"
            f"则…」）、别写成板上钉钉。{severity_note}只输出 JSON：\n"
            "{\n"
            '  "crux": "双方真正的争议焦点在哪",\n'
            f'  "strongest_points": {{"<side_key∈[{sides_keys}]>": "该方去水后的最强论点"}},\n'
            f"{severity_field}"
            '  "factual_disputes": ["关键【事实】分歧（可据证据帮判的）"],\n'
            '  "value_disputes": ["【价值/偏好】分歧（AI 判不了、必须交用户定的）"],\n'
            '  "decisive": "胜负手：一句话点名谁的哪个论点被 drop / 证伪 / 无据，据此定倾向",\n'
            '  "leaning": "你的倾向性判断（基于事实与累计记分哪方更站得住）",\n'
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
            decisive=_as_str(data.get("decisive")),
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


def _as_score(item: dict[str, Any]) -> RoundScore:
    """把裁判返回的单方记分规整为 :class:`RoundScore`（三维 clamp 到 0–5、penalties 去空）。"""

    def _dim(v: Any) -> int:
        try:
            n = int(v)
        except (TypeError, ValueError):
            n = 0
        return max(0, min(5, n))

    return RoundScore(
        argument=_dim(item.get("argument")),
        engagement=_dim(item.get("engagement")),
        evidence=_dim(item.get("evidence")),
        penalties=_as_str_list(item.get("penalties")),
        note=_as_str(item.get("note")),
    )


def _as_scores(value: Any, valid_keys: set[str]) -> dict[str, RoundScore]:
    """把裁判返回的 scores 规整为 {side_key: RoundScore}（记分裁判 P2），只收命中真实 side_key 的方。

    防 LLM 幻觉出不存在的 side；非 dict / 缺失 → 空 dict（记分未开启 or 坏 JSON）：:func:`tally_scores`
    据此退化、简报逐字回退，零副作用（与 clashes / severities 的容错同口径）。
    """
    if not isinstance(value, dict):
        return {}
    out: dict[str, RoundScore] = {}
    for key, item in value.items():
        if str(key) in valid_keys and isinstance(item, dict):
            out[str(key)] = _as_score(item)
    return out


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
_CROSS_EXAM_SYSTEM = (
    "你是一场结构化辩论的主持人，现在主持【质询环节】：代表交锋，向各方发出必须正面回答的尖锐"
    "质询，逼其暴露论证里最站不住脚、最缺证据、涉嫌逻辑谬误的地方。你不替任何一方说话，而是"
    "客观地把每一方最该被追问的命门问出来——尤其【举证责任】：标了【待核实】却当决定性论据、或给了"
    "具体数字/案号却拿不出出处的主张，都要当面逼问。问题要具体、锋利、可被正面回答。严格只输出要求的 JSON。"
)
_ASSESS_SYSTEM = (
    "你是一场结构化辩论的主持人，一身兼裁判与书记：在同一遍审阅里完成三件彼此独立的判断——"
    "① 收敛裁判——做【辩论领域内】的判定（是否真针锋相对、是否还在产生新论点、是否可以收场），"
    "而【不是】评价谁的文笔好，客观严格、不因发言更长就认为更有料；"
    "② 书记——为本轮写一句精炼小结，串起整场的认知推进线，让速读者 30 秒看懂辩论怎么演进；"
    "③ 记分裁判——给各方本轮的【论证有效性 / 证据 / 是否正面回应（含质询）】打分：证据分要看"
    "【来源等级】（一手 / 权威源 = 强，决定性事实仅【单一二手来源】= 弱、封顶打低），逻辑谬误"
    "（如循环论证）与【把待核实 / 无据主张硬拗成既定事实】必须扣分（但辩手【诚实标注待核实】不罚"
    "——诚实存疑是美德不是罪）——这仍是辩论【领域内】的判定，不是通用文笔质量门。"
    "三项判断互不迁就、都要诚实。严格只输出要求的 JSON。"
)
_BRIEF_SYSTEM = (
    "你是一场结构化辩论的主持人。辩论收场时你产出【决策简报】，为用户的决策负责到底：去水提炼"
    "各方最强论点、区分【事实分歧】（可据证据帮判）与【价值/偏好分歧】（必须交用户定）、给出带"
    "置信度与成立条件的倾向判断。【决定性事实若只有二手来源 / 仍待核实，须在结论里保留其证据状态、"
    "不抹成既定事实】——宁可诚实降置信度，不可拿未核实的事实当定论。"
    "务实、诚实，不回避不确定性。严格只输出要求的 JSON。"
)
