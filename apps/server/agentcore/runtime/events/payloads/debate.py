"""Debate orchestration SSE payload wire models."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from agentcore.runtime.events.payloads._base import WirePayload, absent


class EvidenceLedgerEntry(WirePayload):
    """场级证据台账条目（Citation ⊃ 台账字段 + 登记方 side_key）。"""

    id: str  # #e1, #e2, …
    url: str = ""
    title: str = ""
    snippet: str = ""
    site: str = ""
    date: str = ""
    tier: str = "unknown"  # official | media | unknown | weak | blocked
    side_key: str = ""  # 登记方；主持人底料 = moderator


class DebateSideInfo(WirePayload):
    key: str
    name: str
    stance: str
    is_subject: bool
    model: str | None = absent(
        "Display-only model hint on some debate forms; absent on older wire."
    )


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


class DebateHandoffInfo(WirePayload):
    """交接清单条目：按解决路径分类（value / fact / question）。"""

    kind: Literal["value", "fact", "question"]
    text: str


class DebateBriefInfo(WirePayload):
    crux: str
    strongest_points: dict[str, str]
    risk_severities: dict[str, str] = Field(default_factory=dict)
    handoffs: list[DebateHandoffInfo] = Field(default_factory=list)
    decisive: str = ""
    leaning: str
    confidence: str
    recommendation: str


class DebateResultPayload(WirePayload):
    execution_id: str
    moderator_run_id: str
    form: Literal["debate", "red_team", "roundtable"]
    motion: str
    stop_reason: str
    opening: str = ""
    narrative_first: bool
    sides: list[DebateSideInfo]
    rounds: list[DebateRoundInfo]
    closings: list[DebateClosing] = Field(default_factory=list)
    brief: DebateBriefInfo
    # 全场证据台账（权威）；缺字段（老事件）→ []。不动 citations_event。
    evidence_ledger: list[EvidenceLedgerEntry] = Field(default_factory=list)


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


class DebateRoundPayload(DebateRoundInfo):
    execution_id: str
    moderator_run_id: str
