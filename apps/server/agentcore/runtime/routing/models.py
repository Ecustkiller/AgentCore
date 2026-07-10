"""Worker 内部路由 — Intake / Escalation Gate / Sequential Split 的结构化数据。

Intake 只产出轻量计划头（复杂度 + 策略 + token 预算），不产出逐步执行计划，
避免 plan-execution 脱节。Escalation Gate 区分执行层自愈 vs 方案层上报。
Phase 2 顺序分裂：运行时压力触发 → 评估 → 串行 Sub-Worker（深度硬限 1）。
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


# ---------------------------------------------------------------------------
# Phase 2 · Sequential Splitting
# ---------------------------------------------------------------------------


class SplitTrigger(StrEnum):
    """运行时压力触发源（满足任一即进入分裂评估）。"""

    STEPS = "steps"  # current_step_count > max_steps * 0.6
    TOKENS = "tokens"  # token_consumed > max_tokens * 0.7
    TOOL_FAILURES = "tool_failures"  # tool_failure_count > 2


class SplitBudget(BaseModel):
    """父 Worker 的步数 / token 预算（来自 Intake + profile.max_rounds）。"""

    max_steps: int = Field(ge=1, description="本 run 最大 ReAct 轮数")
    max_tokens: int = Field(ge=0, description="本 run token 预算（Intake.token_budget）")


class SplitPressure(BaseModel):
    """一轮 tool_exec 后的实时压力快照。"""

    current_step_count: int = Field(ge=0)
    token_consumed: int = Field(ge=0)
    tool_failure_count: int = Field(ge=0)
    budget: SplitBudget
    triggers: list[SplitTrigger] = Field(default_factory=list)

    @property
    def is_pressured(self) -> bool:
        return bool(self.triggers)

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "current_step_count": self.current_step_count,
            "token_consumed": self.token_consumed,
            "tool_failure_count": self.tool_failure_count,
            "max_steps": self.budget.max_steps,
            "max_tokens": self.budget.max_tokens,
            "triggers": [t.value for t in self.triggers],
        }


class SubTaskSpec(BaseModel):
    """分裂评估产出的单个子任务（顺序执行单元）。"""

    goal: str = Field(min_length=1, description="子任务目标（自包含）")
    constraints: list[str] = Field(default_factory=list, description="执行约束")
    context_summary: str = Field(
        default="",
        description="相关上下文摘要（父 Worker 已完成步骤 + 任务背景）",
    )
    token_budget: int = Field(ge=0, description="从父剩余预算中分配的 token")

    @field_validator("goal")
    @classmethod
    def _goal_stripped(cls, value: str) -> str:
        text = (value or "").strip()
        if not text:
            raise ValueError("goal must be non-empty")
        return text


class SplitDecision(BaseModel):
    """分裂评估结果：是否分裂 + 有序子任务列表。"""

    should_split: bool = False
    rationale: str = Field(default="", description="评估理由（日志 / 诊断）")
    subtasks: list[SubTaskSpec] = Field(default_factory=list)
    triggers: list[SplitTrigger] = Field(default_factory=list)

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "should_split": self.should_split,
            "rationale": self.rationale,
            "triggers": [t.value for t in self.triggers],
            "subtask_count": len(self.subtasks),
            "subtasks": [
                {
                    "goal": s.goal,
                    "constraints": list(s.constraints),
                    "context_summary": s.context_summary,
                    "token_budget": s.token_budget,
                }
                for s in self.subtasks
            ],
        }


class SubWorkerBrief(BaseModel):
    """向下传递给 Sub-Worker 的结构化任务包。"""

    subworker_id: str = Field(min_length=1)
    parent_run_id: str = Field(default="")
    parent_agent_id: str = Field(default="")
    goal: str = Field(min_length=1)
    constraints: list[str] = Field(default_factory=list)
    parent_progress_summary: str = Field(
        default="",
        description="父 Worker 已完成步骤摘要（避免重复工作）",
    )
    context_summary: str = Field(default="")
    token_budget: int = Field(ge=0)
    can_split: bool = Field(
        default=False,
        description="深度硬限：Sub-Worker 恒为 False，不可再分裂",
    )
    depth: int = Field(default=1, ge=1, description="嵌套深度；Phase 2 恒为 1")

    def to_user_message(self) -> str:
        """Render the brief as the Sub-Worker opening user turn."""
        lines = [
            f"[Sub-Worker 任务] {self.goal}",
            "",
            "约束：",
        ]
        if self.constraints:
            lines.extend(f"- {c}" for c in self.constraints)
        else:
            lines.append("- （无额外约束）")
        lines.append("")
        lines.append("父 Worker 已完成：")
        lines.append(self.parent_progress_summary.strip() or "（尚无摘要）")
        if self.context_summary.strip():
            lines.append("")
            lines.append("相关上下文：")
            lines.append(self.context_summary.strip())
        lines.append("")
        lines.append(
            f"预算：最多约 {self.token_budget} tokens。"
            "你只有执行权与升级回报权；不可再分裂子任务。"
            "完成后给出结果摘要、产出物引用，以及若有失败/副作用请明确声明。"
        )
        return "\n".join(lines)

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "subworker_id": self.subworker_id,
            "parent_run_id": self.parent_run_id,
            "parent_agent_id": self.parent_agent_id,
            "goal": self.goal,
            "constraints": list(self.constraints),
            "parent_progress_summary": self.parent_progress_summary,
            "context_summary": self.context_summary,
            "token_budget": self.token_budget,
            "can_split": self.can_split,
            "depth": self.depth,
        }


class SubWorkerResult(BaseModel):
    """Sub-Worker 向上回报。"""

    subworker_id: str = Field(min_length=1)
    success: bool = True
    summary: str = Field(default="", description="结果摘要")
    artifact_refs: list[str] = Field(
        default_factory=list,
        description="产出物引用（文件路径 / 笔记 id 等）",
    )
    failure: str = Field(default="", description="失败信息（成功时可空）")
    side_effects: list[str] = Field(
        default_factory=list,
        description="副作用声明（改了什么状态）",
    )
    tokens_used: int = Field(ge=0, default=0)
    rounds: int = Field(ge=0, default=0)

    def to_event_payload(self) -> dict[str, Any]:
        return {
            "subworker_id": self.subworker_id,
            "success": self.success,
            "summary": self.summary,
            "artifact_refs": list(self.artifact_refs),
            "failure": self.failure,
            "side_effects": list(self.side_effects),
            "tokens_used": self.tokens_used,
            "rounds": self.rounds,
        }

    def to_fold_summary(self) -> str:
        """Compact text for parent journal fold node / parent message injection."""
        status = "ok" if self.success else "failed"
        parts = [f"[{status}] {self.summary or '(无摘要)'}"]
        if self.artifact_refs:
            parts.append("产出: " + ", ".join(self.artifact_refs))
        if self.failure:
            parts.append(f"失败: {self.failure}")
        if self.side_effects:
            parts.append("副作用: " + "; ".join(self.side_effects))
        return " | ".join(parts)
