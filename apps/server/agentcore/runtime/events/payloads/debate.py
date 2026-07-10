"""Debate orchestration SSE payload wire models."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from agentcore.runtime.events.payloads._base import WirePayload, absent


class DebateSideInfo(WirePayload):
    key: str
    name: str
    stance: str
    is_subject: bool
    model: str | None = absent("Display-only model hint on some debate forms; absent on older wire.")


class DebateRoundSide(WirePayload):
    key: str
    name: str
    run_id: str
    ok: bool


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
    ok: bool


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


class DebateNarrativeRound(WirePayload):
    round_no: int
    focus: str
    summary: str
    verdict: DebateVerdict | None
    sides: list[DebateRoundSide]
    clashes: list[DebateClash]
    cross_exam: list[DebateCrossExam]


class DebateBriefInfo(WirePayload):
    crux: str
    strongest_points: dict[str, str]
    risk_severities: dict[str, str] = Field(default_factory=dict)
    factual_disputes: list[str]
    value_disputes: list[str]
    decisive: str = ""
    leaning: str
    confidence: str
    recommendation: str
    open_questions: list[str]


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


class DebateRoundStartedPayload(WirePayload):
    execution_id: str
    moderator_run_id: str
    round_no: int
    focus: str


class DebateRoundPayload(DebateRoundInfo):
    execution_id: str
    moderator_run_id: str


class DebateRoundDecisionRequiredPayload(WirePayload):
    execution_id: str
    moderator_run_id: str
    decision_id: str
    round_no: int
    focus: str
    summary: str
    converged: bool
    rationale: str


class DebateRoundDecisionResolvedPayload(WirePayload):
    execution_id: str
    moderator_run_id: str
    decision_id: str
    decision: Literal["continue", "conclude", "timeout"]
    focus: str
