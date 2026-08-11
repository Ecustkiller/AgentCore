"""Tests for the user run-stop queue (只停这项工作)."""

from agentcore.runtime.runs.stop_queue import (
    enqueue_stop,
    peek_stop_count,
    take_stops,
)


def test_enqueue_and_drain_fifo():
    enqueue_stop(execution_id="exec1", run_id="r1", conversation_id="c1")
    enqueue_stop(execution_id="exec1", run_id=None, conversation_id="c1")
    assert peek_stop_count("exec1") == 2
    drained = take_stops("exec1")
    assert [r.run_id for r in drained] == ["r1", None]
    assert peek_stop_count("exec1") == 0
    assert take_stops("exec1") == []


def test_empty_run_id_normalizes_to_none():
    item = enqueue_stop(execution_id="exec2", run_id="  ", conversation_id="c2")
    assert item.run_id is None
    take_stops("exec2")
