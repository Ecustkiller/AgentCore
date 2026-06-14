"""Tests for plan-review per-agent overrides + effective-knob surfacing (提案 B).

Covers the pure helpers in ``runtime.runs``: ``_effective_knobs`` /
``_agent_card`` (what the run_plan + plan_review_required events carry) and
``_apply_review_overrides`` (how a user's team-preview choice mutates the plan).
"""

from agentcore.runtime.interactions import AgentOverride
from agentcore.runtime.plan import OrchestratorPlan, PlannedAgent, PlannedStep
from agentcore.runtime.runs import (
    _agent_card,
    _apply_review_overrides,
    _effective_knobs,
)


def _plan(*agents: PlannedAgent) -> OrchestratorPlan:
    return OrchestratorPlan(
        plan_type="multi_agent",
        task_summary="t",
        agents=list(agents),
        steps=[PlannedStep(id="s1", agent_id=agents[0].id, task="do")],
    )


# --- _effective_knobs: tier default folded with any override ---


def test_effective_strong_default():
    agent = PlannedAgent(id="a", role="r", model_preference="strong")
    assert _effective_knobs(agent) == (True, "high")


def test_effective_fast_default():
    # Dev-stage: fast tier now thinks at "high" (no non-thinking worker tier).
    agent = PlannedAgent(id="a", role="r", model_preference="fast")
    assert _effective_knobs(agent) == (True, "high")


def test_effective_strong_with_max_override():
    agent = PlannedAgent(
        id="a", role="r", model_preference="strong", reasoning_effort="max"
    )
    assert _effective_knobs(agent) == (True, "max")


def test_effective_none_agent_falls_back_to_strong():
    assert _effective_knobs(None) == (True, "high")


# --- _agent_card: roster entry shape ---


def test_agent_card_carries_effective_knobs():
    agent = PlannedAgent(
        id="a1", role="研究员", model_preference="strong", reasoning_effort="max"
    )
    card = _agent_card(agent)
    assert card == {
        "id": "a1",
        "role": "研究员",
        "model_preference": "strong",
        "thinking": True,
        "reasoning_effort": "max",
    }


# --- _apply_review_overrides: user choice mutates the plan ---


def test_override_unlocks_max_on_strong():
    agent = PlannedAgent(id="a1", role="r", model_preference="strong")
    plan = _plan(agent)
    _apply_review_overrides(
        plan, {"a1": AgentOverride(model_preference="strong", reasoning_effort="max")}
    )
    assert agent.model_preference == "strong"
    assert _effective_knobs(agent) == (True, "max")


def test_override_switches_tier_to_fast():
    agent = PlannedAgent(
        id="a1", role="r", model_preference="strong", reasoning_effort="max"
    )
    plan = _plan(agent)
    _apply_review_overrides(
        plan,
        {"a1": AgentOverride(model_preference="fast", thinking=False, reasoning_effort=None)},
    )
    assert agent.model_preference == "fast"
    # Switching to fast drops effort max→high and shrinks the round budget, but
    # thinking stays on: fast is "high" now, and the upgrade-only clamp ignores
    # the thinking=False downgrade. There is no non-thinking worker tier.
    assert _effective_knobs(agent) == (True, "high")


def test_override_drops_invalid_tier_and_effort():
    agent = PlannedAgent(id="a1", role="r", model_preference="strong")
    plan = _plan(agent)
    _apply_review_overrides(
        plan,
        {"a1": AgentOverride(model_preference="ultra", reasoning_effort="turbo")},
    )
    # Invalid tier ignored (stays strong); invalid effort cleared to None.
    assert agent.model_preference == "strong"
    assert agent.reasoning_effort is None


def test_override_leaves_unnamed_agents_untouched():
    a1 = PlannedAgent(id="a1", role="r", model_preference="strong")
    a2 = PlannedAgent(id="a2", role="r", model_preference="fast")
    plan = OrchestratorPlan(
        plan_type="multi_agent",
        task_summary="t",
        agents=[a1, a2],
        steps=[PlannedStep(id="s1", agent_id="a1", task="do")],
    )
    _apply_review_overrides(plan, {"a1": AgentOverride(reasoning_effort="max")})
    assert _effective_knobs(a1) == (True, "max")
    assert a2.model_preference == "fast"
    assert _effective_knobs(a2) == (True, "high")
