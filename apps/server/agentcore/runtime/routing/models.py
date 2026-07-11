"""Worker 内部路由 — Intake / Escalation Gate 的结构化数据。

Intake 只产出轻量计划头（复杂度 + 策略 + token 预算），不产出逐步执行计划，
避免 plan-execution 脱节。Escalation Gate 区分执行层自愈 vs 方案层上报。
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class Complexity(StrEnum):
    """任务预估复杂度（Intake 产出）。"""

    SIMPLE = "simple"
    MODERATE = "moderate"
    COMPLEX = "complex"


class ExecutionStrategy(StrEnum):
    """Intake 建议的执行策略（Phase 1 仅标记，不触发分裂）。"""

    DIRECT_EXECUTE = "direct_execute"
    NEEDS_TOOLS = "needs_tools"
    NEEDS_RESEARCH = "needs_research"


class ProblemLayer(StrEnum):
    """Escalation Gate 对障碍的分层。"""

    EXECUTION = "execution"  # 工具报错 / 重试 / 路径 — Worker 自愈
    SCHEME = "scheme"  # 需求矛盾 / 契约 / 权限 — 停下上报


class EscalationKind(StrEnum):
    """方案层升级的细分类（对齐现有 escalate kind 语义，便于调度层消费）。"""

    NORMAL = "normal"
    SCOPE = "scope"
    DEP = "dep"
    CONTRACT = "contract"  # 需改接口契约 / 权限越界
    CONTRADICTION = "contradiction"  # 需求矛盾


class IntakeResult(BaseModel):
    """Worker 接到任务后的轻量计划头。

    不包含逐步执行步骤——只给复杂度、策略与预算，供 Gate / 治理读取。
    """

    complexity: Complexity
    strategy: ExecutionStrategy
    token_budget: int = Field(ge=0, description="本 run 预估 token 预算（粗估）")
    rationale: str = Field(default="", description="简短理由（日志 / 诊断用）")
    signals: list[str] = Field(
        default_factory=list,
        description="触发评估的关键词 / 启发式信号（可观测，非用户文案）",
    )

    def to_event_payload(self) -> dict[str, Any]:
        """Wire shape for ``run_intake`` (snake_case leaf)."""
        return {
            "complexity": self.complexity.value,
            "strategy": self.strategy.value,
            "token_budget": self.token_budget,
            "rationale": self.rationale,
            "signals": list(self.signals),
        }


class EscalationSignal(BaseModel):
    """方案层问题的结构化升级信号（Gate 产出 → 调度层消费）。"""

    layer: ProblemLayer = ProblemLayer.SCHEME
    kind: EscalationKind = EscalationKind.NORMAL
    question: str = Field(min_length=1, description="需上级拍板 / 知晓的问题（自包含）")
    assumption: str = Field(
        default="",
        description="Worker 在等待答复前采用的假设（可空；阻塞路径建议填写）",
    )
    evidence: str = Field(
        default="",
        description="触发判定的证据摘要（工具名 / 错误片段，preview 级）",
    )
    tool_name: str = Field(default="", description="触发检查的工具名（可空）")
    source: str = Field(
        default="escalation_gate",
        description="信号来源：escalation_gate（确定性门）vs escalate_tool（模型主动）",
    )

    @field_validator("question")
    @classmethod
    def _question_stripped(cls, value: str) -> str:
        text = (value or "").strip()
        if not text:
            raise ValueError("question must be non-empty")
        return text

    def to_run_escalation_payload(self) -> dict[str, Any]:
        """Shape compatible with ``RunState.escalations`` / CEO aggregate harvest."""
        kind = self.kind.value
        # CEO / wave 边界只认 normal|scope|dep；contract/contradiction 映射到 scope
        # （方案层偏离），避免改动调度契约。
        wire_kind = kind if kind in ("normal", "scope", "dep") else "scope"
        return {
            "question": self.question,
            "assumption": self.assumption,
            "blocking": False,
            "kind": wire_kind,
            "source": self.source,
            "gate_kind": kind,
            "evidence": self.evidence,
            "tool_name": self.tool_name,
            "layer": self.layer.value,
        }


class GateVerdict(BaseModel):
    """一次 tool_exec 轮次后的 Escalation Gate 判定。"""

    layer: ProblemLayer = ProblemLayer.EXECUTION
    action: str = Field(
        default="continue",
        description="continue = 自愈继续；escalate = 方案层停下并上报",
    )
    signals: list[EscalationSignal] = Field(default_factory=list)

    @property
    def should_escalate(self) -> bool:
        return self.action == "escalate" and self.layer is ProblemLayer.SCHEME
