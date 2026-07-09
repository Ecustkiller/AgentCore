"""辩论编排数据模型 —— 主持人（Moderator）循环的类型地基。

把辩论从「`delegate` 上的 stance/round 展示标记 + CEO 手搓跨轮 DAG」重设计为「主持人
驱动、过程与结论双产物」的能力（见 docs/03-AI核心/辩论编排设计.md）。本模块只定形状：

- :class:`DebateForm` / :class:`DebateSide` / :class:`DebateConfig` —— 一场辩论的配置（三
  形态统一模型：参与方泛化为「立场标签」，破二元 pro/con）。
- :class:`SideTurn` / :class:`JudgeVerdict` / :class:`RoundResult` —— 一轮的产物（各方发
  言 + 收敛裁判 + 主持人小结），是过程产物「交锋叙事线」的逐轮单元。
- :class:`DebateBrief` / :class:`DebateResult` —— 双产物（决策简报 + 叙事线），主持人交回
  CEO 收尾的最终交付。
- :class:`RoundRunner` —— 主持人「派一轮辩手发言」的注入接口；真实实现用现有
  ``build_agent_executor`` / ``continue_run`` 执行，单测注入 fake 零成本驱动循环。

本模块刻意 import-light（只依赖标准库），让编排循环与裁判逻辑可脱离 LLM / 执行器单测。

→ 见设计: docs/03-AI核心/辩论编排设计.md
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol

# ── 轮次治理默认（辩论编排设计.md §五） ──────────────────────────────────────
# 轮数永不暴露给用户设定：用户只选形态，收敛由主持人逐轮自判（无最小轮门槛强制多轮）。这些
# 是纯「安全上限」（防失控的断路器），不是目标值——收敛永远可早于它发生。
DEFAULT_MAX_ROUNDS = 5  # 安全上限（正反/红队）：达到即停（防失控兜底，非目标）
DEFAULT_MAX_ROUNDS_QUICK = 1  # 「快速对碰」上限：单轮即收
# 圆桌（探讨型）上限略紧于辩论（铺满观点光谱即可，无需正反那种对抗强度的轮数）。
DEFAULT_MAX_ROUNDS_ROUNDTABLE = 4


class DebateForm(StrEnum):
    """辩论的三形态（辩论编排设计.md §三）——一套主持人循环参数化而成，非独立执行路径。"""

    DEBATE = "debate"  # 正反辩论：正/反 2 方对称攻防
    RED_TEAM = "red_team"  # 红队挑刺：被审方案 + 1~N 红队单向攻击 → 方案方回应
    ROUNDTABLE = "roundtable"  # 多方圆桌：3~N 个视角多边碰撞


@dataclass(frozen=True)
class DebateSide:
    """一个参与方 —— 把 pro/con 泛化为「立场标签」（辩论编排设计.md §三）。

    ``key`` 是机器标识（用于 run_id / 前端分桶 / 跨轮续写定位），``name`` 是展示名
    （正方 / 红队A / 经济学视角），``stance`` 是喂给辩手的立场定位（拼进它的角色补充）。
    ``is_subject`` 标记红队形态里那个「被审方案方」（单向攻击的承受方），其余形态恒 False。

    ``model`` 是该方辩手的【显式模型覆写】（Phase 3 · 真·多模型辩手）：``schema.parse_sides``
    仍解析入库，但 MVP 全链路统一用户 model，``debater_task`` 不注入、``to_event_payload``
    不对外发此字段——各方实际跑同一 turn model；见 ``辩论编排设计.md`` §7.5。
    """

    key: str
    name: str
    stance: str
    is_subject: bool = False
    model: str = ""


@dataclass(frozen=True)
class RoundPolicy:
    """轮次治理参数（辩论编排设计.md §五）。

    收敛由主持人【每轮自判】（:meth:`Moderator._judge` 的 ``converged``）决定——本类【不再设
    最小轮门槛】强制多轮（旧法的机械楼层不看内容、把 trivial 命题也逼满 N 轮、产出冗余「修订
    v2」）。「别过早收敛」的智慧已搬进裁判的逐轮标准（第 1 轮开场默认继续、除非命题空泛无可
    再辩），不再靠外部计数兜底。

    ``thorough`` 是喂给裁判的【深度偏好】：True=盯住决定性分歧往深里辩、逼到分出高下或见底成
    价值选择才收（不是把每个角度都辩一遍），False=核心交锋清晰即收；``max_rounds`` 是纯【安全
    上限】（防失控的断路器，非目标值、罕见兜底），收敛永远可早于它发生。
    """

    thorough: bool = True
    max_rounds: int = DEFAULT_MAX_ROUNDS

    def __post_init__(self) -> None:
        # 安全上限至少 1 轮（否则循环空转）。
        object.__setattr__(self, "max_rounds", max(1, self.max_rounds))

    @classmethod
    def quick(cls) -> RoundPolicy:
        """「快速对碰」：单轮即收（上限 1）——裁判一次对碰即判收敛，不强制多轮。"""
        return cls(thorough=False, max_rounds=DEFAULT_MAX_ROUNDS_QUICK)

    @classmethod
    def for_form(cls, form: DebateForm, *, thorough: bool = True) -> RoundPolicy:
        """形态默认 policy。

        ``thorough=False`` 对**所有形态**（含圆桌）一律快速单轮——「测试一下 / 简单看看 / 随便
        聊聊」不该被强制多轮（旧实现圆桌恒多轮、忽略 ``thorough``，trivial 命题也产出冗余「修订
        v2」）。``thorough=True`` 时圆桌探讨上限略紧（铺光谱即可）、正反/红队认真辩透；轮数仍由
        主持人逐轮自判收敛，``max_rounds`` 只是安全上限。"""
        if not thorough:
            return cls.quick()
        if form is DebateForm.ROUNDTABLE:
            return cls(thorough=True, max_rounds=DEFAULT_MAX_ROUNDS_ROUNDTABLE)
        return cls(thorough=True, max_rounds=DEFAULT_MAX_ROUNDS)


@dataclass
class DebateConfig:
    """一场辩论的完整配置 —— 用户只抛「问题」或选「形态」，参与方/轮数由系统定。

    ``motion`` 是辩论命题（用户问题）；``sides`` 是泛化后的参与方（≥2）；``policy`` 收敛/轮
    次治理；``model_preference`` 是辩手与主持人 LLM 调用的质量档（fast/strong）。
    """

    motion: str
    form: DebateForm
    sides: list[DebateSide]
    policy: RoundPolicy = field(default_factory=RoundPolicy)
    model_preference: str = "strong"

    @property
    def subject_side(self) -> DebateSide | None:
        """红队形态里的「被审方案方」（其余形态返回 None）。"""
        return next((s for s in self.sides if s.is_subject), None)


@dataclass
class SideTurn:
    """某方在某一轮的发言产物 —— 叙事线 L3「论点级全文」的承载单元。

    ``ok`` 标记该方本轮是否成功产出（辩手 run 失败 / 空产出时 False）：裁判与小结基于成功
    发言进行，全员失败则主持人提前终止（出降级简报）。``run_id`` 让前端把发言挂到图节点、
    并供跨轮续写定位同一辩手。
    """

    side_key: str
    side_name: str
    run_id: str
    content: str
    ok: bool = True


@dataclass(frozen=True)
class DebateClash:
    """论点级交锋边（叙事线 L3「谁驳谁」）—— 裁判逐轮抽取的针锋相对关系。

    ``from_key`` 一方针对性反驳了 ``to_key`` 一方，``point`` 是这条反驳的要点（一句话）。
    ``from_key``/``to_key`` 是 :class:`DebateSide` 的 ``key``（语义键，非 run_id）。只抽**真正
    针锋相对**的边（各说各话不算），让前端把「平铺发言」升级为可读的交锋图（而非靠用户脑补）。
    """

    from_key: str
    to_key: str
    point: str


@dataclass
class CrossExamQa:
    """质询环节的一条 Q↔A（质询回合 P1 最小单元）。

    ``question`` verbatim 进 SSE payload；``answer`` 为从辩手作答中解析出的该条摘要（完整流仍随
    ``answer_run_id`` 的 run 事件走）；``ok`` 标记该条是否正面回答（回避 / 未答 → 裁判扣 engagement）。
    """

    question: str
    answer: str = ""
    ok: bool = True


@dataclass
class CrossExamExchange:
    """一轮【质询环节】对某方的逐条交换组（质询回合，辩论编排设计.md §4-2.1）。

    质询环节由主持人代表交锋、向某方（``target``= :class:`DebateSide` 的 key）发出【必须正面回答】
    的尖锐质询（``exchanges``，通常 2–3 条、可含是/否逼答），被质询方在【自己的 transcript】上逐条
    作答（``answer_run_id`` 挂到执行图节点、全文随 run 事件走）。``questioner`` 是提问方 side_key，
    空=主持人代表交锋（当前实现）——保留字段以便日后切到「辩手互相质询」而不改契约。质询问答随本轮
    :class:`RoundResult` 留痕并喂进裁判记分（回避 / 答非所问 → 扣 engagement）——这正是「让交锋当面
    发生、把回避与被戳穿变成可记分」的落点。
    """

    target: str
    exchanges: list[CrossExamQa] = field(default_factory=list)
    answer_run_id: str = ""
    questioner: str = ""


@dataclass
class ClosingStatement:
    """某方的【结辩陈词】（阶段化发言角色 P4 · 结辩收束，辩论编排设计.md §4-2.4 契约④）。

    辩已辩尽（收敛 / 用户 conclude / 达上限）后、简报前，主持人请各方做一段收尾陈词：辩手在【自己的
    transcript】上 ``continue_run`` 产出（带全程记忆），**只讲胜负手**（本方最强 1–2 点 + 为何对方最关键
    的反驳不成立）、**不得引入新论据 / 新事实**、长度收紧（见 :data:`~agentcore.tools.builtin.debate.
    schema.CLOSING_LENGTH_HINT`）。全文随 ``run_id`` 的 run 事件走（不塞 payload，与各方发言 / 质询作答
    同策），``ok`` 标记是否成功产出。收场后**一次性**发生（非逐轮），供前端「结辩」区渲染——这一层是
    辩手自己的 advocacy 收尾，与裁判中立的 ``brief.decisive`` 正交并存（真人辩论：结辩 + 裁决并存）。
    仅【认真辩透 + 对抗形态】开启；未开启 / 快速对碰 / 圆桌恒空，零行为变化。
    """

    side_key: str
    side_name: str
    run_id: str
    content: str = ""
    ok: bool = True


@dataclass(frozen=True)
class UserInterjection:
    """直播中用户向某轮辩论注入的「追问」—— verbatim 复盘单元（辩论编排设计.md §逐轮交互 / 交锋
    叙事直播态设计 Phase 2）。

    用户在第 N 轮边界选 ``CONTINUE`` 时可附带一个问题（``ask``），可选定向某方（``target_key``
    = :class:`DebateSide` 的 key，空=问全场）。该追问被注入【下一轮】辩手 prompt（见
    :func:`round_feedback`）令其正面回应——故它逻辑上归属「被它驱动的那一轮」（round N+1）。
    ``answered`` 记录【结构事实】：是否真有后续轮跑起来承接它（追问即续辩，正常恒 True；若在轮数
    上限边界追问、其后无轮，或紧接超时/异常无下一轮，则 False）——非「答得好不好」的语义判断。

    这是唯一【耐久】的用户追问痕迹（决策事件 transport-only 不入 journal）：随 ``RoundResult``
    进 ``debate_result.rounds[*].user_interjections``，重载后复盘可见。
    """

    ask: str
    target_key: str = ""
    answered: bool = False


class RoundDecision(StrEnum):
    """用户在一轮辩论边界的抉择（交互式逐轮，opt-in；辩论编排设计.md §逐轮交互）。

    辩论默认由裁判逐轮自判收敛；当 ``debate(interactive=true)`` 且有活跃用户时，主持人每轮判完
    后把决定权交给用户：``CONTINUE`` 再辩一轮（``RoundBoundary.focus`` 留空=主持人自动定下一轮
    焦点，非空=用户「加的角度」覆写焦点），``CONCLUDE`` 直接出结论（即便裁判未判收敛）。无第三态
    —— v1 不做「加辩方 / 换辩手」。超时 / 无活跃用户回落裁判自动收敛（见 Moderator.run）。
    """

    CONTINUE = "continue"
    CONCLUDE = "conclude"


@dataclass(frozen=True)
class RoundBoundary:
    """一轮边界的处置 —— :class:`RoundDecision` + 可选的下一轮焦点覆写（「加角度」）+ 追问。

    ``focus`` 仅在 ``decision is CONTINUE`` 且非空时生效：作为下一轮的议题覆写主持人自动定焦点
    （用户把辩论引向自己在意的维度=「引导」）；``CONCLUDE`` 时忽略。

    ``ask`` 是用户的【追问】（与 ``focus`` 正交：焦点改的是议题，追问是一个要辩手正面回答的问题）：
    非空时注入【下一轮】辩手 prompt 令其回应（``ask_target`` 指定方 key，空=问全场），并作为
    :class:`UserInterjection` 随下一轮 :class:`RoundResult` 留痕复盘。追问即续辩，故仅 ``CONTINUE``
    时被承接；``CONCLUDE`` 时若仍带 ``ask`` 则记为未应答（无后续轮）。

    主持人收到 ``None``（未接钩子 / 超时 / 无活跃用户）则回退到裁判的自动收敛判定。
    """

    decision: RoundDecision
    focus: str = ""
    ask: str = ""
    ask_target: str = ""


@dataclass
class RoundScore:
    """某方在某一轮的【记分】（记分裁判，辩论编排设计.md §4-2.2）。

    裁判在**辩论领域内**给各方本轮打分（不是判「谁文笔好」的通用质量门，见设计 §二 / 提案 §2.3）：
    ``argument`` 论点强度、``engagement`` 回应完整度（是否正面回应对方命门与质询、有无 drop / 回避）、
    ``evidence`` 证据充分度，各 0–5；``penalties`` 记本轮的谬误与未支撑主张（每条一句话，如「循环论证：
    拿未生效判决当论据」），每条计 -1；``note`` 一句话记分理由。收场倾向由逐轮记分累计推导
    （:func:`tally_scores`），而非收场一次性拍脑袋——让 leaning 与实际交锋对齐。
    """

    argument: int = 0
    engagement: int = 0
    evidence: int = 0
    penalties: list[str] = field(default_factory=list)
    note: str = ""

    @property
    def total(self) -> int:
        """本轮净得分：三维之和减去谬误 / 无据的罚分（每条 -1），可为负。"""
        return self.argument + self.engagement + self.evidence - len(self.penalties)


@dataclass
class JudgeVerdict:
    """收敛裁判结果（辩论编排设计.md §二 第3步 + §五）。

    主持人的「裁判」是**辩论领域内**的交锋质量与收敛判定（非通用产物质量门，见设计 §二）：
    ``real_clash`` 各方是否真针锋相对（而非各说各话）、``new_arguments`` 本轮是否还在产生新
    论点。``converged`` 是裁判判「可终止」——主持人循环【直接据此收场】（无最小轮门槛二次约束，
    「别过早收敛」已内化进裁判的逐轮标准）；终止时 ``stop_reason`` 取 :data:`STOP_REASONS` 之一，
    继续时 ``next_focus`` 给下一轮焦点。

    ``scores`` 是本轮【记分裁判】的各方得分（side_key → :class:`RoundScore`，记分裁判 P2）：与收敛
    判定同一遍推理产出，逐轮累计后驱动收场倾向。空 dict = 未开启记分（快速对碰 / 坏 JSON 容错 /
    未升级路径），此时行为逐字回退到「只判交锋与收敛」，零变化。
    """

    real_clash: bool
    new_arguments: bool
    converged: bool
    stop_reason: str = ""
    next_focus: str = ""
    rationale: str = ""
    clashes: list[DebateClash] = field(default_factory=list)
    scores: dict[str, RoundScore] = field(default_factory=dict)


# 终止条件词表（辩论编排设计.md §五）——裁判判收敛时给出的归因，前端可据此呈现「为何收场」。
STOP_CONVERGED = "converged"  # 各方无实质新论点（开始重复）
STOP_FOCUS_CLARIFIED = "focus_clarified"  # 分歧已归结为价值/偏好之争（AI 判不了，交用户）
STOP_RED_TEAM_EXHAUSTED = "red_team_exhausted"  # 无新风险可挖（红队专用）
STOP_MAX_ROUNDS = "max_rounds"  # 达轮数硬上限（兜底，由循环而非裁判判定）
STOP_ALL_FAILED = "all_failed"  # 某轮全员发言失败，主持人提前终止
STOP_USER_CONCLUDED = "user_concluded"  # 交互式逐轮：用户在轮边界选择「够了，出结论」
STOP_REASONS = frozenset(
    {
        STOP_CONVERGED,
        STOP_FOCUS_CLARIFIED,
        STOP_RED_TEAM_EXHAUSTED,
        STOP_MAX_ROUNDS,
        STOP_ALL_FAILED,
        STOP_USER_CONCLUDED,
    }
)


@dataclass
class RoundResult:
    """一轮完整结果 —— 交锋叙事线 L2「逐轮攻防」的单元。

    ``focus`` 本轮议题（主持人第1步所定）；``turns`` 各方发言（L3 全文）；``verdict`` 收敛
    裁判（第3步）；``summary`` 主持人本轮小结（第4步，叙事线 L1「焦点小结流」的单元）。
    """

    round_no: int
    focus: str
    turns: list[SideTurn]
    verdict: JudgeVerdict
    summary: str = ""
    # 驱动本轮的用户追问（交互式逐轮，opt-in）：用户在【上一轮】边界注入、本轮辩手须正面回应的
    # 问题（verbatim 复盘单元）。非交互 / 无追问恒空。详见 :class:`UserInterjection`。
    user_interjections: list[UserInterjection] = field(default_factory=list)
    # 本轮【质询环节】的问答（质询回合 P1，opt-in：仅认真辩透 + 对抗形态开启）。主持人代表交锋向
    # 各方发出必答质询、被质询方 continue_run 作答，喂进裁判记分。非质询路径恒空。详见 :class:`CrossExamExchange`。
    cross_exam: list[CrossExamExchange] = field(default_factory=list)

    @property
    def ok_turns(self) -> list[SideTurn]:
        """本轮成功产出的发言（裁判 / 小结的输入）。"""
        return [t for t in self.turns if t.ok]

    def to_event_payload(self) -> dict:
        """本轮结构化为 SSE 事件 payload —— ``debate_round`` 事件与 :meth:`DebateResult.
        to_event_payload` 的逐轮单元共用此一处（单一源，防漂移）。

        承载叙事线一轮（focus / verdict / summary）+ 各方→辩手 ``run_id`` 映射；发言【全文】
        不在此（体量大、随辩手 run 走执行事件），靠 ``sides[*].run_id`` 关联执行图辩手节点。
        """
        return {
            "round_no": self.round_no,
            "focus": self.focus,
            "summary": self.summary,
            "verdict": {
                "real_clash": self.verdict.real_clash,
                "new_arguments": self.verdict.new_arguments,
                "converged": self.verdict.converged,
                "stop_reason": self.verdict.stop_reason,
                "rationale": self.verdict.rationale,
            },
            "sides": [
                {
                    "key": t.side_key,
                    "name": t.side_name,
                    "run_id": t.run_id,
                    "ok": t.ok,
                }
                for t in self.turns
            ],
            # L3 论点级交锋边（谁驳谁）—— 裁判逐轮抽取，与 sides 平级（key 引 sides[*].key）。
            "clashes": [
                {"from_key": c.from_key, "to_key": c.to_key, "point": c.point}
                for c in self.verdict.clashes
            ],
            # 驱动本轮的用户追问（verbatim 复盘）：恒带（无追问为空列表），载荷形状统一。
            "user_interjections": [
                {"ask": i.ask, "target_key": i.target_key, "answered": i.answered}
                for i in self.user_interjections
            ],
            # 质询环节（质询回合 P1）：逐条 Q↔A verbatim 进载荷（answer 为解析摘要；完整流随
            # answer_run_id 的 run 事件走，与各方发言全文同策），恒带（无质询为空列表），载荷形状统一。
            "cross_exam": [
                {
                    "target": cx.target,
                    "questioner": cx.questioner,
                    "exchanges": [
                        {
                            "question": ex.question,
                            "answer": ex.answer,
                            "ok": ex.ok,
                        }
                        for ex in cx.exchanges
                    ],
                    "answer_run_id": cx.answer_run_id,
                }
                for cx in self.cross_exam
            ],
            # 记分裁判（P2）：本轮各方得分（side_key → 三维 + 罚分 + 净分），前端渲染逐轮比分条。
            # 与 verdict 平级（不塞进 verdict 子 dict，守其既有键集不漂移）；无记分为空 dict。
            "scores": {
                key: {
                    "argument": sc.argument,
                    "engagement": sc.engagement,
                    "evidence": sc.evidence,
                    "penalties": list(sc.penalties),
                    "note": sc.note,
                    "total": sc.total,
                }
                for key, sc in self.verdict.scores.items()
            },
        }


@dataclass
class DebateBrief:
    """决策简报 —— 结论产物（辩论编排设计.md §4.1）。

    辩论的「为决策负责到底」落点：不只把正反并排甩给用户，而是去水提炼 + 区分事实/价值分歧
    + 给出带置信度的倾向判断。``factual_disputes`` 是 AI 能据证据帮判的关键事实分歧，
    ``value_disputes`` 是必须交用户定的价值/偏好分歧（两者分流是简报的核心价值）。
    """

    crux: str  # 争议焦点：双方真正分歧在哪
    strongest_points: dict[str, str] = field(default_factory=dict)  # side_key → 去水最强论点
    # 红队专用：红队成员 side_key → 该风险严重度（high/medium/low），驱动前端「风险看板」按严重度
    # 分级 + 总览计数。非红队形态恒空；被审方案方（is_subject）不评级。
    risk_severities: dict[str, str] = field(default_factory=dict)
    factual_disputes: list[str] = field(default_factory=list)  # 关键事实分歧（AI 可帮判）
    value_disputes: list[str] = field(default_factory=list)  # 价值/偏好分歧（交用户）
    # 胜负手（记分裁判 P2）：一句话点名【谁的哪个论点被 drop / 被证伪 / 无据】，据此定倾向——让
    # leaning 由实际交锋记分驱动、可追溯，而非收场拍脑袋。空=未开启记分（零变化回退）。
    decisive: str = ""
    leaning: str = ""  # 主持人倾向性判断
    confidence: str = ""  # 置信度（含成立条件，如「若你更看重 X 则反向」）
    recommendation: str = ""  # 给用户的建议
    open_questions: list[str] = field(default_factory=list)  # 仅剩需你拍板的点


@dataclass
class DebateResult:
    """辩论总产物 —— 双产物（决策简报 + 交锋叙事线），主持人交回 CEO 收尾。

    ``rounds`` 是过程产物（叙事线全部逐轮单元）；``brief`` 是结论产物。``stop_reason`` 记录
    整场为何收场（取 :data:`STOP_REASONS`）。:meth:`to_ceo_output` 渲染成 CEO 循环可读的
    markdown（简报 + L1 焦点小结流；L2/L3 全文走 SSE 事件给前端，不塞进 CEO 上下文）。
    """

    config: DebateConfig
    rounds: list[RoundResult]
    brief: DebateBrief
    stop_reason: str = STOP_CONVERGED
    # 主持人开场白（第 1 轮 :meth:`Moderator._frame` 顺带产出）：主持人口吻的一句定调，供前端顶部
    # 「会说话的主持人」气泡渲染。空（未产出 / 解析失败）时前端回落到模板开场白，故是锦上添花、
    # 非硬依赖。
    opening: str = ""
    # 各方【结辩陈词】（阶段化发言角色 P4）：辩已辩尽后各方的收尾 advocacy，全文随 run_id 走执行事件
    # （不塞 payload）。仅认真辩透 + 对抗形态开启；未开启 / 快速对碰 / 圆桌 / 全员失败恒空。详见
    # :class:`ClosingStatement`。
    closings: list[ClosingStatement] = field(default_factory=list)

    @property
    def narrative_first(self) -> bool:
        """呈现顺序（辩论编排设计.md §4.3）：探讨/学习类（圆桌）过程叙事线先行，决策类
        （正反/红队）决策简报先行。前端据此排版，CEO 收尾文本也据此调整侧重。"""
        return self.config.form is DebateForm.ROUNDTABLE

    @property
    def node_summary(self) -> str:
        """团队图上主持人节点的一行预览：「N 轮 · 收敛归因」。

        节点是「一眼概览」位——详尽的争议焦点 / 倾向 / 建议在 debate_result 卡片里，故节点只
        给【轮数 + 为何收场】（``stop_reason`` 的人话）：比塞 ``brief.crux`` 更稳定、信息密度更
        高（crux 可能为空 / 冗长、且已在卡片重复，旧法 crux 落空时退化成「辩论收场：N 轮」的
        近空预览）。复用 :func:`_stop_label`（与 CEO 文本头、前端「为何收场」同一词表）。"""
        return f"{len(self.rounds)} 轮 · {_stop_label(self.stop_reason)}"

    def to_ceo_output(self) -> str:
        """折算回 CEO 循环的 markdown：决策简报 + L1 焦点小结流（按形态调顺序）。"""
        brief_md = _render_brief(self.brief, self.config)
        narrative_md = _render_narrative_l1(self.rounds)
        rounds_n = len(self.rounds)
        head = (
            f"## 辩论结果（{_form_label(self.config.form)} · {rounds_n} 轮 · "
            f"{_stop_label(self.stop_reason)}）\n"
        )
        body = [narrative_md, brief_md] if self.narrative_first else [brief_md, narrative_md]
        tail = (
            "\n\n---\n以上为本场辩论的**决策简报 + 交锋叙事线**（用户可在界面展开逐轮攻防与"
            "各方全文）。请用你自己的声音据此收尾：先给用户结论与建议，点出仅剩需他拍板的点。"
            "【收尾铁律·别抹平证据状态】简报里凡标了【待核实】/【需一手核实】、或注明仅【二手来源】的"
            "关键事实，你转述时【必须保留这份保留语】（如「据多家媒体报道、尚待一手核实」），"
            "绝不写成板上钉钉的既定事实——宁可诚实存疑，不可拿未核实的事实给用户当定论。"
        )
        return head + "\n\n".join(p for p in body if p.strip()) + tail

    def to_event_payload(self) -> dict:
        """结构化为 SSE 事件 payload（前端辩论视图渲染用）。

        承载交锋叙事线（rounds 的 focus / verdict / summary）+ 决策简报 + 参与方定义；各方
        发言【全文】不在此（体量大、且已随辩手 run 走执行事件），靠 ``rounds[*].sides[*].
        run_id`` 关联执行图的辩手节点取回。``narrative_first`` 供前端按形态调呈现顺序。
        """
        return {
            "form": self.config.form.value,
            "motion": self.config.motion,
            "stop_reason": self.stop_reason,
            # 主持人开场白：前端顶部「会说话的主持人」气泡；空则回落模板开场白。
            "opening": self.opening,
            "narrative_first": self.narrative_first,
            "sides": [
                {
                    "key": s.key,
                    "name": s.name,
                    "stance": s.stance,
                    "is_subject": s.is_subject,
                }
                for s in self.config.sides
            ],
            "rounds": [rr.to_event_payload() for rr in self.rounds],
            # 各方结辩陈词（阶段化发言角色 P4）：问题/身份 verbatim 进载荷、陈词全文随 run_id 的 run
            # 事件走（不塞载荷，与各方发言 / 质询作答同策），恒带（无结辩为空列表），载荷形状统一。
            "closings": [
                {
                    "key": c.side_key,
                    "name": c.side_name,
                    "run_id": c.run_id,
                    "ok": c.ok,
                }
                for c in self.closings
            ],
            "brief": {
                "crux": self.brief.crux,
                "strongest_points": dict(self.brief.strongest_points),
                # 红队风险严重度（side_key → high/medium/low）：前端风险看板按它分级 + 计数；
                # 其余形态恒空 dict，载荷形状统一。
                "risk_severities": dict(self.brief.risk_severities),
                "factual_disputes": list(self.brief.factual_disputes),
                "value_disputes": list(self.brief.value_disputes),
                # 胜负手（记分裁判 P2）：一句话点名谁的哪点被 drop / 证伪 / 无据；空=未开启记分。
                "decisive": self.brief.decisive,
                "leaning": self.brief.leaning,
                "confidence": self.brief.confidence,
                "recommendation": self.brief.recommendation,
                "open_questions": list(self.brief.open_questions),
            },
        }


@dataclass(frozen=True)
class DebateSeedRound:
    """上一场辩论某轮的摘要单元（结构化补轮种子，辩论编排设计.md §6.6）。"""

    round_no: int
    focus: str
    summary: str


@dataclass(frozen=True)
class DebateSeed:
    """上一场辩论的结构化摘要 —— 「结构化补轮」（可逆叫停·B）的播种源。

    来自前端持有的上一场 ``debate_result`` 载荷（**不含辩手全文**——全文随辩手 run 走执行事件、
    不进 debate_result），由前端投影成最小形回传。据此让续辩：① :meth:`Moderator._frame` 正交于
    已谈焦点（不重复换汤）；② 首个新轮辩手 task 读到上一场的论点摘要（各方最强论点 + 逐轮焦点/小结
    + 未决分歧），从「读懂上一场」处接着辩。新一场仍是独立 :class:`DebateResult`（新 turn = 新卡），
    由本种子「告知」而非原地改写（守事件源 turn 模型）。空 / 无实质内容时 :meth:`from_payload` 返
    ``None``（=不播种、逐字回退到全新辩论，零行为变化）。
    """

    motion: str = ""
    rounds: tuple[DebateSeedRound, ...] = ()
    strongest_points: dict[str, str] = field(default_factory=dict)  # side_key → 上一场最强论点
    crux: str = ""
    leaning: str = ""
    value_disputes: tuple[str, ...] = ()
    open_questions: tuple[str, ...] = ()

    @property
    def covered_focuses(self) -> list[str]:
        """上一场已谈过的逐轮焦点（喂给 ``_frame`` 强制正交，续辩不重复换说法重谈）。"""
        return [r.focus for r in self.rounds if r.focus]

    @classmethod
    def from_payload(cls, payload: dict | None) -> DebateSeed | None:
        """从前端送来的 ``debate_result``-形载荷宽容解析；无实质内容 → ``None``（不播种）。

        容忍完整 debate_result 载荷或前端投影的最小形（两者同形：``motion`` / ``rounds[*].
        {round_no,focus,summary}`` / ``brief.{crux,strongest_points,leaning,value_disputes,
        open_questions}``）。任意字段缺失 / 类型不符都降级为空，绝不抛错中断辩论。
        """
        if not isinstance(payload, dict):
            return None

        def _str(v: Any) -> str:
            return v.strip() if isinstance(v, str) else ""

        def _strs(v: Any) -> tuple[str, ...]:
            if not isinstance(v, list):
                return ()
            return tuple(s for s in (_str(x) for x in v) if s)

        rounds: list[DebateSeedRound] = []
        raw_rounds = payload.get("rounds")
        if isinstance(raw_rounds, list):
            for r in raw_rounds:
                if not isinstance(r, dict):
                    continue
                focus = _str(r.get("focus"))
                summary = _str(r.get("summary"))
                if not (focus or summary):
                    continue
                try:
                    rno = int(r.get("round_no") or 0)
                except (TypeError, ValueError):
                    rno = 0
                rounds.append(DebateSeedRound(round_no=rno, focus=focus, summary=summary))

        raw_brief = payload.get("brief")
        brief = raw_brief if isinstance(raw_brief, dict) else {}
        raw_sp = brief.get("strongest_points")
        strongest = (
            {str(k): _str(v) for k, v in raw_sp.items() if _str(v)}
            if isinstance(raw_sp, dict)
            else {}
        )
        seed = cls(
            motion=_str(payload.get("motion")),
            rounds=tuple(rounds),
            strongest_points=strongest,
            crux=_str(brief.get("crux")),
            leaning=_str(brief.get("leaning")),
            value_disputes=_strs(brief.get("value_disputes")),
            open_questions=_strs(brief.get("open_questions")),
        )
        # 无任何实质内容（没轮次摘要、没最强论点、没未决分歧）⇒ 不值得播种，回退全新辩论。
        if not (seed.rounds or seed.strongest_points or seed.value_disputes or seed.open_questions):
            return None
        return seed


class RoundRunner(Protocol):
    """主持人「派一轮辩手发言」的注入接口 —— 隔离编排循环与执行器。

    真实实现（DebateTool）：首轮用 ``build_agent_executor`` + ``WaveScheduler`` 派各方并行
    发言，后续轮用 ``continue_run`` 让同一辩手在自己 transcript 上续写（把对方上轮论点当
    feedback 注入）——这正是「辩手跨轮带记忆」的落点。单测注入 fake，零成本驱动循环。

    入参 ``history`` 是已完成的各轮（含各方上轮发言），实现据此给辩手注入对方论点；
    ``interjections`` 是用户在上一轮边界注入、本轮须正面回应的【追问】（交互式逐轮，opt-in；
    非交互 / 无追问恒空）——实现把它拼进辩手 feedback（见 :func:`round_feedback`）。返回本轮
    各方发言（与 ``sides`` 一一对应，失败方 ``ok=False``）。
    """

    async def __call__(
        self,
        *,
        round_no: int,
        focus: str,
        sides: Sequence[DebateSide],
        history: Sequence[RoundResult],
        interjections: Sequence[UserInterjection] = (),
    ) -> list[SideTurn]: ...


class CrossExamRunner(Protocol):
    """主持人「派一轮质询作答」的注入接口 —— 对称于 :class:`RoundRunner`，隔离编排循环与执行器。

    主持人先据本轮立论生成【定向各方的必答质询】（:meth:`Moderator._cross_exam_questions`），再把
    ``questions``（side_key → 问题列表）交给本 runner：真实实现（DebateTool）让每个被质询方用
    ``continue_run`` 在自己 transcript 上正面作答，返回各方的 :class:`CrossExamExchange`（作答全文进
    该方 session 记忆、下一轮立论续写可见）；单测注入 fake 零成本驱动。仅在【认真辩透 + 对抗形态】
    开启（快速对碰 / 圆桌跳过，见 :meth:`Moderator._cross_exam_enabled`），故为**可选**注入——
    未注入 / 未开启时循环逐字回退到「立论→裁判」，零行为变化。
    """

    async def __call__(
        self,
        *,
        round_no: int,
        focus: str,
        sides: Sequence[DebateSide],
        turns: Sequence[SideTurn],
        questions: dict[str, list[str]],
    ) -> list[CrossExamExchange]: ...


class ClosingRunner(Protocol):
    """主持人「派一轮结辩陈词」的注入接口 —— 对称于 :class:`CrossExamRunner`（阶段化发言角色 P4）。

    辩论收场后（收敛 / 用户 conclude / 达上限）、简报前，主持人请各方做收尾陈词：真实实现（DebateTool）
    让每个仍有 session 的方用 ``continue_run`` 在自己 transcript 上出一段结辩（带全程记忆，故只需给
    「只讲胜负手、不引入新论据」的 feedback，见 :func:`closing_task`），返回各方 :class:`ClosingStatement`
    （陈词全文进该方 run 事件）；单测注入 fake 零成本驱动。仅在【认真辩透 + 对抗形态】开启（快速对碰 /
    圆桌跳过，见 :meth:`Moderator._closing_enabled`），故为**可选**注入——未注入 / 未开启时循环收场后
    逐字回退到「直接出简报」，零行为变化。``rounds`` 是全部已完成轮（实现可据末轮焦点点题，当前实现
    依赖辩手全程记忆、不额外注入）。
    """

    async def __call__(
        self,
        *,
        sides: Sequence[DebateSide],
        rounds: Sequence[RoundResult],
    ) -> list[ClosingStatement]: ...


def tally_scores(rounds: Sequence[RoundResult]) -> dict[str, RoundScore]:
    """把各轮各方的 :class:`RoundScore` 累加成每方一个【累计分】（记分裁判 P2）。

    三维逐轮相加、``penalties`` 全场并起（``note`` 累计无意义、留空）。某方某轮无记分则跳过。收场
    :meth:`Moderator._brief` 据此让 leaning / decisive 与实际交锋记分对齐（净分更高 / 罚分更少的一方
    更站得住），而非收场一次性拍脑袋。无任何记分（未开启 P2）返回空 dict——简报逐字回退，零变化。
    """
    tally: dict[str, RoundScore] = {}
    for rr in rounds:
        for key, sc in rr.verdict.scores.items():
            agg = tally.get(key)
            if agg is None:
                tally[key] = RoundScore(
                    argument=sc.argument,
                    engagement=sc.engagement,
                    evidence=sc.evidence,
                    penalties=list(sc.penalties),
                )
            else:
                agg.argument += sc.argument
                agg.engagement += sc.engagement
                agg.evidence += sc.evidence
                agg.penalties.extend(sc.penalties)
    return tally


# ── 渲染辅助（CEO 文本折算用；前端走 SSE 事件，不复用这些） ─────────────────────


def _form_label(form: DebateForm) -> str:
    return {
        DebateForm.DEBATE: "正反辩论",
        DebateForm.RED_TEAM: "红队挑刺",
        DebateForm.ROUNDTABLE: "多方圆桌",
    }.get(form, str(form))


def _severity_label(sev: str) -> str:
    """红队风险严重度枚举 → 中文（与前端风险看板同口径）；未知值原样回显。"""
    return {"high": "高", "medium": "中", "low": "低"}.get(sev, sev)


def _stop_label(reason: str) -> str:
    return {
        STOP_CONVERGED: "已收敛",
        STOP_FOCUS_CLARIFIED: "焦点已澄清为价值之争",
        STOP_RED_TEAM_EXHAUSTED: "风险已挖尽",
        STOP_MAX_ROUNDS: "达轮数上限",
        STOP_ALL_FAILED: "辩手发言失败提前终止",
        STOP_USER_CONCLUDED: "用户选择出结论",
    }.get(reason, reason or "已结束")


def _render_brief(brief: DebateBrief, config: DebateConfig) -> str:
    lines = ["### 决策简报"]
    if brief.crux:
        lines.append(f"- **争议焦点**：{brief.crux}")
    for side in config.sides:
        point = brief.strongest_points.get(side.key)
        if point:
            sev = brief.risk_severities.get(side.key)
            sev_tag = f"（风险严重度：{_severity_label(sev)}）" if sev else ""
            lines.append(f"- **{side.name}最强论点**{sev_tag}：{point}")
    if brief.factual_disputes:
        lines.append("- **关键事实分歧（可据证据帮判）**：")
        lines.extend(f"  - {d}" for d in brief.factual_disputes)
    if brief.value_disputes:
        lines.append("- **价值/偏好分歧（需你定）**：")
        lines.extend(f"  - {d}" for d in brief.value_disputes)
    if brief.decisive:
        lines.append(f"- **胜负手（据逐轮记分）**：{brief.decisive}")
    if brief.leaning:
        conf = f"（置信度：{brief.confidence}）" if brief.confidence else ""
        lines.append(f"- **倾向判断**{conf}：{brief.leaning}")
    if brief.recommendation:
        lines.append(f"- **建议**：{brief.recommendation}")
    if brief.open_questions:
        lines.append("- **仅剩需你拍板的点**：")
        lines.extend(f"  - {q}" for q in brief.open_questions)
    return "\n".join(lines)


def _render_narrative_l1(rounds: list[RoundResult]) -> str:
    lines = ["### 交锋叙事线（焦点小结）"]
    for rr in rounds:
        focus = rr.focus or "（本轮焦点未定）"
        summary = rr.summary or rr.verdict.rationale or "（本轮小结缺失）"
        lines.append(f"- **第 {rr.round_no} 轮 · {focus}**：{summary}")
    return "\n".join(lines)
