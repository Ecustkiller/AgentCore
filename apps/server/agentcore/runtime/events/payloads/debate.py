"""Debate orchestration SSE payload wire models."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from agentcore.runtime.debate.types import DebateForm
from agentcore.runtime.events.payloads._base import WirePayload, absent


class EvidenceLedgerEntry(WirePayload):
    """场级证据台账条目（Citation ⊃ 台账字段 + 登记方 side_key）。

    约定文档预登记（批 D2）可选来源锚：``dossier_path`` / ``origin_id`` / ``dossier_label``；
    旧 journal / 旧向量缺字段 → 前端忽略，零回归。
    """

    id: str  # #r1, #r2, …
    url: str = ""
    title: str = ""
    snippet: str = ""
    site: str = ""
    date: str = ""
    tier: str = "unknown"  # official | media | unknown | weak | blocked
    side_key: str = ""  # 登记方；主持人底料 = moderator；约定文档预登记 = dossier
    # 约定文档来源锚（additive）：工作区相对路径 / 幕1 #rN / 透镜人话标签。
    dossier_path: str = ""
    origin_id: str = ""
    dossier_label: str = ""


class DebateSideInfo(WirePayload):
    key: str
    name: str
    stance: str
    is_subject: bool
    # §7.5 真·多模型：已消歧行属性；缺字段（老 journal / 同模型场）→ 前端跟 run 实际 model。
    model: str | None = absent("该方辩手模型 id。")
    origin: Literal["platform", "byok"] | None = absent("付款来源（行属性）。")
    provider_id: str | None = absent("BYOK 服务商 id。")


class DebateSpeechArgument(WirePayload):
    """辩手发言的一条结构化论点（后端 speech_parse 产出）。"""

    id: str
    title: str
    body: str


class DebateRoundSide(WirePayload):
    key: str
    name: str
    run_id: str
    ok: bool
    # 部分失败续赛时该方缺席（无立论）；跳过对其质询与对抗记分。缺字段（老事件）→ false。
    absent: bool = False
    # 结构化论点大纲；缺字段 / 空列表（老 journal）→ 前端启发式回退 parseSpeechArguments。
    arguments: list[DebateSpeechArgument] = Field(default_factory=list)
    # 轮内 beat；缺字段（老 journal / 正反）→ statement。旧磁带可带已删形态拍名。
    beat: Literal["statement", "attack", "defense", "rebuttal", "thread", "crux"] = "statement"


class DebateVerdict(WirePayload):
    real_clash: bool
    new_arguments: bool
    converged: bool
    stop_reason: str
    rationale: str


class DebateClash(WirePayload):
    from_key: str
    to_key: str
    point: str


class DebateUserInterjection(WirePayload):
    ask: str
    target_key: str
    answered: bool


class DebateCrossExamExchange(WirePayload):
    question: str
    answer: str


class DebateCrossExam(WirePayload):
    target: str
    questioner: str
    exchanges: list[DebateCrossExamExchange]
    answer_run_id: str


class DebateWitnessExam(WirePayload):
    """批 D1 · 证人答问（additive）：主持人点名幕1 透镜证人的事实性问答。"""

    witness_key: str
    lens_run_id: str
    seat_run_id: str = ""
    name: str
    origin_caption: str = ""
    exchanges: list[DebateCrossExamExchange] = Field(default_factory=list)
    answer_run_id: str = ""


class DebateWitnessSeat(WirePayload):
    """批 D1 · 本场证人席位花名册条目。"""

    key: str
    name: str
    lens_run_id: str
    seat_run_id: str
    lens_label: str = ""
    origin_caption: str = ""


class DebateClosing(WirePayload):
    key: str
    name: str
    run_id: str
    ok: bool


class DebateRoundScore(WirePayload):
    argument: int
    engagement: int
    evidence: int
    penalties: list[str]
    note: str
    total: int


class DebateRoundInfo(WirePayload):
    round_no: int
    focus: str
    summary: str
    verdict: DebateVerdict
    sides: list[DebateRoundSide]
    clashes: list[DebateClash]
    user_interjections: list[DebateUserInterjection] = Field(default_factory=list)
    cross_exam: list[DebateCrossExam] = Field(default_factory=list)
    # 批 D1 · 证人答问；缺字段（老事件）→ []。
    witness_exam: list[DebateWitnessExam] = Field(default_factory=list)
    scores: dict[str, DebateRoundScore] = Field(default_factory=dict)
    # 本轮新登记的证据台账增量（live 徽章可溯源）；缺字段（老事件）→ []。
    evidence_ledger_delta: list[EvidenceLedgerEntry] = Field(default_factory=list)


class DebateNarrativeRound(WirePayload):
    round_no: int
    focus: str
    summary: str
    verdict: DebateVerdict | None
    sides: list[DebateRoundSide]
    clashes: list[DebateClash]
    cross_exam: list[DebateCrossExam]
    witness_exam: list[DebateWitnessExam] = Field(default_factory=list)


class DebateHandoffInfo(WirePayload):
    """交接清单条目：按解决路径分类（value / fact / question）。"""

    kind: Literal["value", "fact", "question"]
    text: str


class DebateBriefInfo(WirePayload):
    crux: str
    strongest_points: dict[str, str]
    # 退役：新场次恒空；旧载荷降级渲染仍可读。
    risk_severities: dict[str, str] = Field(default_factory=dict)
    handoffs: list[DebateHandoffInfo] = Field(default_factory=list)
    decisive: str = ""
    leaning: str
    confidence: str
    recommendation: str


class DebateResultPayload(WirePayload):
    execution_id: str
    moderator_run_id: str
    form: DebateForm
    motion: str
    stop_reason: str
    opening: str = ""
    narrative_first: bool
    sides: list[DebateSideInfo]
    rounds: list[DebateRoundInfo]
    closings: list[DebateClosing] = Field(default_factory=list)
    # 批 D1 · 证人席位花名册；缺字段（老事件）→ []。
    witnesses: list[DebateWitnessSeat] = Field(default_factory=list)
    brief: DebateBriefInfo
    # 全场证据台账（权威）；缺字段（老事件）→ []。不动 citations_event。
    evidence_ledger: list[EvidenceLedgerEntry] = Field(default_factory=list)
    # §7.5 裁判选型；缺字段（老 journal）→ 前端忽略。
    moderator_model: str | None = absent("裁判模型 id。")
    moderator_origin: Literal["platform", "byok"] | None = absent("裁判模型来源。")
    moderator_provider_id: str | None = absent("裁判 BYOK provider_id。")
    same_model_debate: bool | None = absent("同模型降级明示。")


class DebateRoundStartedPayload(WirePayload):
    execution_id: str
    moderator_run_id: str
    round_no: int
    focus: str
    # 本场是否开启质询（与 cross_exam_enabled(config) 同源）。每轮开场重复声明同一场常量；
    # 缺字段（老事件）→ 前端回退「正在小结…」。optional+default 保持向后兼容。
    cross_exam_enabled: bool = False
    # 主持人开场白：仅首轮携带（后续轮空/缺省）。前端 sticky 取第一个非空，不被后续覆盖；
    # 收场 debate_result.opening 仍是权威。缺字段（老 journal）→ ""。
    opening: str = ""
    # 形态信号供 live 状态条；缺字段（老事件）→ 前端可回退 group 前缀推断。
    form: DebateForm | None = absent(
        "Form signal for live status; absent on older wire."
    )


class DebateRoundPayload(DebateRoundInfo):
    execution_id: str
    moderator_run_id: str
