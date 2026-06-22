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
from typing import Protocol

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
    """

    key: str
    name: str
    stance: str
    is_subject: bool = False


@dataclass(frozen=True)
class RoundPolicy:
    """轮次治理参数（辩论编排设计.md §五）。

    收敛由主持人【每轮自判】（:meth:`Moderator._judge` 的 ``converged``）决定——本类【不再设
    最小轮门槛】强制多轮（旧法的机械楼层不看内容、把 trivial 命题也逼满 N 轮、产出冗余「修订
    v2」）。「别过早收敛」的智慧已搬进裁判的逐轮标准（第 1 轮开场默认继续、除非命题空泛无可
    再辩），不再靠外部计数兜底。

    ``thorough`` 是喂给裁判的【深度偏好】：True=未挖尽实质分歧不轻易收，False=核心交锋清晰即
    收；``max_rounds`` 是纯【安全上限】（防失控的断路器，非目标值），收敛永远可早于它发生。
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
class JudgeVerdict:
    """收敛裁判结果（辩论编排设计.md §二 第3步 + §五）。

    主持人的「裁判」是**辩论领域内**的交锋质量与收敛判定（非通用产物质量门，见设计 §二）：
    ``real_clash`` 各方是否真针锋相对（而非各说各话）、``new_arguments`` 本轮是否还在产生新
    论点。``converged`` 是裁判判「可终止」——主持人循环【直接据此收场】（无最小轮门槛二次约束，
    「别过早收敛」已内化进裁判的逐轮标准）；终止时 ``stop_reason`` 取 :data:`STOP_REASONS` 之一，
    继续时 ``next_focus`` 给下一轮焦点。
    """

    real_clash: bool
    new_arguments: bool
    converged: bool
    stop_reason: str = ""
    next_focus: str = ""
    rationale: str = ""
    clashes: list[DebateClash] = field(default_factory=list)


# 终止条件词表（辩论编排设计.md §五）——裁判判收敛时给出的归因，前端可据此呈现「为何收场」。
STOP_CONVERGED = "converged"  # 各方无实质新论点（开始重复）
STOP_FOCUS_CLARIFIED = "focus_clarified"  # 分歧已归结为价值/偏好之争（AI 判不了，交用户）
STOP_RED_TEAM_EXHAUSTED = "red_team_exhausted"  # 无新风险可挖（红队专用）
STOP_MAX_ROUNDS = "max_rounds"  # 达轮数硬上限（兜底，由循环而非裁判判定）
STOP_ALL_FAILED = "all_failed"  # 某轮全员发言失败，主持人提前终止
STOP_REASONS = frozenset(
    {
        STOP_CONVERGED,
        STOP_FOCUS_CLARIFIED,
        STOP_RED_TEAM_EXHAUSTED,
        STOP_MAX_ROUNDS,
        STOP_ALL_FAILED,
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
    factual_disputes: list[str] = field(default_factory=list)  # 关键事实分歧（AI 可帮判）
    value_disputes: list[str] = field(default_factory=list)  # 价值/偏好分歧（交用户）
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
            "brief": {
                "crux": self.brief.crux,
                "strongest_points": dict(self.brief.strongest_points),
                "factual_disputes": list(self.brief.factual_disputes),
                "value_disputes": list(self.brief.value_disputes),
                "leaning": self.brief.leaning,
                "confidence": self.brief.confidence,
                "recommendation": self.brief.recommendation,
                "open_questions": list(self.brief.open_questions),
            },
        }


class RoundRunner(Protocol):
    """主持人「派一轮辩手发言」的注入接口 —— 隔离编排循环与执行器。

    真实实现（DebateTool）：首轮用 ``build_agent_executor`` + ``WaveScheduler`` 派各方并行
    发言，后续轮用 ``continue_run`` 让同一辩手在自己 transcript 上续写（把对方上轮论点当
    feedback 注入）——这正是「辩手跨轮带记忆」的落点。单测注入 fake，零成本驱动循环。

    入参 ``history`` 是已完成的各轮（含各方上轮发言），实现据此给辩手注入对方论点；返回本轮
    各方发言（与 ``sides`` 一一对应，失败方 ``ok=False``）。
    """

    async def __call__(
        self,
        *,
        round_no: int,
        focus: str,
        sides: Sequence[DebateSide],
        history: Sequence[RoundResult],
    ) -> list[SideTurn]: ...


# ── 渲染辅助（CEO 文本折算用；前端走 SSE 事件，不复用这些） ─────────────────────


def _form_label(form: DebateForm) -> str:
    return {
        DebateForm.DEBATE: "正反辩论",
        DebateForm.RED_TEAM: "红队挑刺",
        DebateForm.ROUNDTABLE: "多方圆桌",
    }.get(form, str(form))


def _stop_label(reason: str) -> str:
    return {
        STOP_CONVERGED: "已收敛",
        STOP_FOCUS_CLARIFIED: "焦点已澄清为价值之争",
        STOP_RED_TEAM_EXHAUSTED: "风险已挖尽",
        STOP_MAX_ROUNDS: "达轮数上限",
        STOP_ALL_FAILED: "辩手发言失败提前终止",
    }.get(reason, reason or "已结束")


def _render_brief(brief: DebateBrief, config: DebateConfig) -> str:
    lines = ["### 决策简报"]
    if brief.crux:
        lines.append(f"- **争议焦点**：{brief.crux}")
    for side in config.sides:
        point = brief.strongest_points.get(side.key)
        if point:
            lines.append(f"- **{side.name}最强论点**：{point}")
    if brief.factual_disputes:
        lines.append("- **关键事实分歧（可据证据帮判）**：")
        lines.extend(f"  - {d}" for d in brief.factual_disputes)
    if brief.value_disputes:
        lines.append("- **价值/偏好分歧（需你定）**：")
        lines.extend(f"  - {d}" for d in brief.value_disputes)
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
