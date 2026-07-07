"""SimAgent persona and motivation models (M1)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class BigFive(BaseModel):
    openness: float = Field(default=0.5, ge=0.0, le=1.0)
    conscientiousness: float = Field(default=0.5, ge=0.0, le=1.0)
    extraversion: float = Field(default=0.5, ge=0.0, le=1.0)
    agreeableness: float = Field(default=0.5, ge=0.0, le=1.0)
    neuroticism: float = Field(default=0.5, ge=0.0, le=1.0)


class SimPersona(BaseModel):
    """Immutable role card for one SimAgent."""

    agent_id: str
    name: str
    role: str
    location: str
    goal: str
    system_prompt: str
    big_five: BigFive = Field(default_factory=BigFive)
    goals_stack: list[str] = Field(default_factory=list)

    def effective_goals(self) -> list[str]:
        if self.goals_stack:
            return list(self.goals_stack)
        return [self.goal] if self.goal else []


class MotivationAssessment(BaseModel):
    """Placeholder utility layer for M2+; M1 returns neutral scores."""

    urgency: float = 0.5
    social_pull: float = 0.5
    resource_need: float = 0.5

    @staticmethod
    def evaluate(_persona: SimPersona, _perception: str) -> MotivationAssessment:
        return MotivationAssessment()
