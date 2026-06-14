"""Tests for the EventSink execution journal (Phase 2 history persistence).

The sink taps every emitted run/tool event into an ordered journal so the turn's
multi-agent team graph can be persisted on the assistant message and replayed on
reload. A turn that never delegated (no ``run_plan``) persists nothing.
"""

from agentcore.runtime.events import (
    EventSink,
    EventType,
    FinishReason,
    content_delta,
    message_end,
    message_start,
    run_completed,
    run_plan,
    run_started,
    tool_use_end,
    tool_use_start,
)


def _plan() -> object:
    return run_plan(
        execution_id="exec-1",
        plan_type="multi_agent",
        task_summary="2 个 worker",
        agents=[{"id": "a1", "role": "研究员"}],
        runs=[{"id": "s1", "agent_id": "a1", "task": "调研", "depends_on": []}],
    )


def test_journal_accumulates_run_and_tool_events_in_order():
    sink = EventSink()
    sink.emit(_plan())
    sink.emit(run_started("s1", "a1"))
    sink.emit(tool_use_start("t1", "web_search", {"q": "x"}))
    sink.emit(tool_use_end("t1", "web_search", success=True, output="ok"))
    sink.emit(run_completed("s1", "a1", output_summary="done", duration_ms=12))

    journal = sink.execution_journal()
    assert journal is not None
    types = [e["type"] for e in journal]
    assert types == [
        EventType.RUN_PLAN.value,
        EventType.RUN_STARTED.value,
        EventType.TOOL_USE_START.value,
        EventType.TOOL_USE_END.value,
        EventType.RUN_COMPLETED.value,
    ]
    # Each entry carries the replayable shape: type + payload + timestamp.
    assert all(set(e) == {"type", "payload", "timestamp"} for e in journal)
    assert journal[1]["payload"]["run_id"] == "s1"


def test_non_execution_events_are_not_journalled():
    sink = EventSink()
    sink.emit(message_start("m1", conversation_id="c1"))
    sink.emit(_plan())
    sink.emit(content_delta("hello"))
    sink.emit(message_end(FinishReason.END_TURN))

    journal = sink.execution_journal()
    assert journal is not None
    # Only the run_plan is journalled — message_start / content_delta / message_end
    # are conversation-stream events, not part of the team graph.
    assert [e["type"] for e in journal] == [EventType.RUN_PLAN.value]


def test_no_plan_means_no_runs_payload():
    """A single-agent turn (CEO tool calls but never delegating) persists no runs."""
    sink = EventSink()
    sink.emit(content_delta("just chatting"))
    sink.emit(tool_use_start("t1", "web_search", {"q": "x"}))
    sink.emit(tool_use_end("t1", "web_search", success=True, output="ok"))

    assert sink.execution_journal() is None


def test_events_after_close_are_not_journalled():
    sink = EventSink()
    sink.emit(_plan())
    sink.close()
    sink.emit(run_started("s1", "a1"))  # dropped: stream already closed

    journal = sink.execution_journal()
    assert journal is not None
    assert [e["type"] for e in journal] == [EventType.RUN_PLAN.value]
