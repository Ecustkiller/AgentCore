"""RunPlan.replace semantics: replaces_run_id rewrites downstream depends_on."""

from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunKind, RunSpec


def _spec(
    run_id: str,
    depends_on: list[str] | None = None,
    *,
    replaces_run_id: str | None = None,
) -> RunSpec:
    return RunSpec(
        run_id=run_id,
        agent_id=run_id,
        agent_name=run_id,
        kind=RunKind.AGENT,
        task=f"task-{run_id}",
        role=run_id,
        depends_on=list(depends_on or []),
        replaces_run_id=replaces_run_id,
    )


def test_add_with_replaces_rewrites_downstream_depends_on():
    plan = RunPlan()
    plan.add(_spec("r1"))
    plan.add(_spec("r2"))
    plan.add(_spec("writer", ["r1", "r2"]))

    plan.add(_spec("r1b", replaces_run_id="r1"))

    writer = plan.by_id("writer")
    assert writer is not None
    assert writer.depends_on == ["r1b", "r2"]
    assert plan.by_id("r1b") is not None
    assert plan.by_id("r1b").replaces_run_id == "r1"


def test_rewrite_dedupes_when_new_id_already_listed():
    plan = RunPlan()
    plan.add(_spec("r1"))
    plan.add(_spec("r1b"))
    plan.add(_spec("writer", ["r1", "r1b"]))

    touched = plan.rewrite_depends_for_replace(_spec("r1b", replaces_run_id="r1"))
    assert touched == ["writer"]
    assert plan.by_id("writer").depends_on == ["r1b"]


def test_rewrite_no_op_without_replaces_or_matching_dep():
    plan = RunPlan()
    plan.add(_spec("r1"))
    plan.add(_spec("writer", ["r1"]))
    assert plan.rewrite_depends_for_replace(_spec("x", replaces_run_id=None)) == []
    assert plan.by_id("writer").depends_on == ["r1"]
    assert plan.rewrite_depends_for_replace(_spec("x", replaces_run_id="missing")) == []
    assert plan.by_id("writer").depends_on == ["r1"]
