"""Orchestrator plan schema and tolerant parsing.

The planner LLM emits a JSON collaboration plan. This module defines the typed
structures and a parser that ALWAYS yields a valid plan: any malformed or
unreasonable output falls back to a safe single-agent plan
(编排器Prompt与输出结构.md §七).
"""

import json
from dataclasses import dataclass, field

_MAX_AGENTS = 5
_MAX_STEPS = 20
_VALID_PREFS = {"fast", "strong"}
_DEFAULT_PREF = "strong"
_VALID_EFFORTS = {"high", "max"}
_VALID_MERGE = {"direct", "sequential", "merge", "compare"}


@dataclass
class PlannedAgent:
    id: str
    role: str
    objective: str = ""
    system_prompt_supplement: str | None = None
    tools: list[str] = field(default_factory=list)
    model_preference: str = _DEFAULT_PREF
    # Optional per-agent overrides (提案 B). ``None`` = not declared → use the
    # tier default. Stored raw (enum-validated only); the upgrade-only clamp
    # against the tier baseline happens in ``llm.config.apply_overrides``.
    thinking: bool | None = None
    reasoning_effort: str | None = None


@dataclass
class PlannedStep:
    id: str
    agent_id: str
    task: str
    depends_on: list[str] = field(default_factory=list)
    expected_output: str = ""


@dataclass
class PlannedCheckpoint:
    after_step: str
    reason: str = ""
    review_focus: str = ""


@dataclass
class OutputStrategy:
    merge_type: str = "direct"
    final_summary: bool = False


@dataclass
class OrchestratorPlan:
    plan_type: str
    task_summary: str
    agents: list[PlannedAgent]
    steps: list[PlannedStep]
    checkpoints: list[PlannedCheckpoint] = field(default_factory=list)
    output_strategy: OutputStrategy = field(default_factory=OutputStrategy)
    max_parallel: int = 10

    @property
    def is_multi_agent(self) -> bool:
        return len(self.steps) > 1 or len(self.agents) > 1

    def agent_by_id(self, agent_id: str) -> PlannedAgent | None:
        return next((a for a in self.agents if a.id == agent_id), None)


def single_agent_plan(task_summary: str, tools: list[str]) -> OrchestratorPlan:
    """Safe fallback: one agent, one step, direct output."""
    summary = task_summary.strip() or "回答用户的问题"
    if len(summary) > 80:
        summary = summary[:80] + "…"
    return OrchestratorPlan(
        plan_type="single_agent",
        task_summary=summary,
        agents=[
            PlannedAgent(
                id="agent_1",
                role="通用助手",
                objective="直接回答用户的问题",
                tools=list(tools),
                model_preference=_DEFAULT_PREF,
            )
        ],
        steps=[PlannedStep(id="step_1", agent_id="agent_1", task=task_summary, depends_on=[])],
        output_strategy=OutputStrategy(merge_type="direct", final_summary=False),
    )


def parse_plan(
    raw: str, *, fallback_summary: str, available_tools: list[str]
) -> OrchestratorPlan:
    """Parse planner output into a validated plan, falling back on any failure."""
    try:
        data = _extract_json(raw)
        plan = _build_plan(data, available_tools=available_tools)
        _assert_acyclic(plan)
        return plan
    except Exception:
        return single_agent_plan(fallback_summary, available_tools)


def _extract_json(raw: str) -> dict:
    text = raw.strip()
    if "```" in text:
        # Strip a ```json ... ``` fence if present.
        start = text.find("```")
        fence = text[start + 3 :]
        if fence.lower().startswith("json"):
            fence = fence[4:]
        end = fence.rfind("```")
        if end != -1:
            fence = fence[:end]
        text = fence.strip()
    first = text.find("{")
    last = text.rfind("}")
    if first == -1 or last == -1 or last < first:
        raise ValueError("no JSON object found")
    return json.loads(text[first : last + 1])


def _parse_thinking(raw: object) -> bool | None:
    """Read an optional ``thinking`` override, tolerating string booleans.

    Returns ``None`` (not declared) for anything that is not a clear bool, so the
    tier default applies. Note: only ``True`` ever upgrades downstream; a declared
    ``False`` is kept here but later ignored by the upgrade-only clamp.
    """
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.strip().lower() in {"true", "false"}:
        return raw.strip().lower() == "true"
    return None


def _parse_effort(raw: object) -> str | None:
    """Read an optional ``reasoning_effort`` override, validated to high/max."""
    value = str(raw or "").strip().lower()
    return value if value in _VALID_EFFORTS else None


def _build_plan(data: dict, *, available_tools: list[str]) -> OrchestratorPlan:
    tool_set = set(available_tools)

    raw_agents = data.get("agents") or []
    agents: list[PlannedAgent] = []
    for a in raw_agents[:_MAX_AGENTS]:
        aid = str(a.get("id") or "").strip()
        if not aid:
            continue
        pref = str(a.get("model_preference") or _DEFAULT_PREF)
        if pref not in _VALID_PREFS:
            pref = _DEFAULT_PREF
        agent_tools = [t for t in (a.get("tools") or []) if t in tool_set]
        agents.append(
            PlannedAgent(
                id=aid,
                role=str(a.get("role") or "助手"),
                objective=str(a.get("objective") or ""),
                system_prompt_supplement=a.get("system_prompt_supplement") or None,
                tools=agent_tools,
                model_preference=pref,
                thinking=_parse_thinking(a.get("thinking")),
                reasoning_effort=_parse_effort(a.get("reasoning_effort")),
            )
        )

    if not agents:
        raise ValueError("no valid agents")

    agent_ids = {a.id for a in agents}
    raw_steps = data.get("steps") or []
    steps: list[PlannedStep] = []
    step_ids: set[str] = set()
    for s in raw_steps[:_MAX_STEPS]:
        sid = str(s.get("id") or "").strip()
        agent_id = str(s.get("agent_id") or "").strip()
        if not sid or agent_id not in agent_ids:
            continue
        step_ids.add(sid)
        steps.append(
            PlannedStep(
                id=sid,
                agent_id=agent_id,
                task=str(s.get("task") or ""),
                depends_on=[str(d) for d in (s.get("depends_on") or [])],
                expected_output=str(s.get("expected_output") or ""),
            )
        )

    if not steps:
        raise ValueError("no valid steps")

    # Drop dangling dependencies (references to unknown steps).
    for step in steps:
        step.depends_on = [d for d in step.depends_on if d in step_ids and d != step.id]

    raw_cps = data.get("checkpoints") or []
    checkpoints = [
        PlannedCheckpoint(
            after_step=str(c.get("after_step") or ""),
            reason=str(c.get("reason") or ""),
            review_focus=str(c.get("review_focus") or ""),
        )
        for c in raw_cps
        if str(c.get("after_step") or "") in step_ids
    ]

    os_data = data.get("output_strategy") or {}
    merge_type = str(os_data.get("merge_type") or "sequential")
    if merge_type not in _VALID_MERGE:
        merge_type = "sequential"
    output_strategy = OutputStrategy(
        merge_type=merge_type,
        final_summary=bool(os_data.get("final_summary", len(steps) > 1)),
    )

    is_multi = len(steps) > 1 or len(agents) > 1
    return OrchestratorPlan(
        plan_type="multi_agent" if is_multi else "single_agent",
        task_summary=str(data.get("task_summary") or "").strip() or "处理用户请求",
        agents=agents,
        steps=steps,
        checkpoints=checkpoints,
        output_strategy=output_strategy,
        max_parallel=int((data.get("constraints") or {}).get("max_parallel", 10)),
    )


def _assert_acyclic(plan: OrchestratorPlan) -> None:
    """Raise if the dependency graph has a cycle (Kahn's algorithm)."""
    indegree = {s.id: 0 for s in plan.steps}
    adj: dict[str, list[str]] = {s.id: [] for s in plan.steps}
    for s in plan.steps:
        for dep in s.depends_on:
            indegree[s.id] += 1
            adj[dep].append(s.id)

    queue = [sid for sid, deg in indegree.items() if deg == 0]
    visited = 0
    while queue:
        node = queue.pop()
        visited += 1
        for nxt in adj[node]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)

    if visited != len(plan.steps):
        raise ValueError("plan dependency graph has a cycle")
