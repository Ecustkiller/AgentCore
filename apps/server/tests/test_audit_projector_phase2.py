"""Unit tests for Phase 2 audit projection."""

from agentcore.runtime.audit.projector import project_journal_entry, project_run_retry
from agentcore.runtime.audit.recorder import AuditRecorder


def test_checkpoint_journal_projection():
    recorder = AuditRecorder(
        user_id="u1",
        conversation_id="c1",
        turn_id="t1",
        trace_id="trace1",
        captain_run_id="captain-1",
        delegated=True,
    )
    paused = project_journal_entry(
        recorder,
        {"kind": "checkpoint_required", "payload": {"checkpoint_id": "ck1", "question": "?"}}
    )
    resumed = project_journal_entry(
        recorder,
        {"kind": "checkpoint_resolved", "payload": {"checkpoint_id": "ck1", "decision": "continue"}},
    )
    assert paused is not None
    assert paused.action == "checkpoint.paused"
    assert paused.category == "state"
    assert resumed is not None
    assert resumed.action == "checkpoint.resumed"


def test_run_retry_projection():
    recorder = AuditRecorder(
        user_id="u1",
        conversation_id="c1",
        turn_id="t1",
        trace_id="trace1",
        captain_run_id="captain-1",
        delegated=True,
    )
    draft = project_run_retry(
        recorder,
        run_id="w1",
        attempt=2,
        source="on_failure",
        error="timeout",
    )
    assert draft.action == "run.retry"
    assert draft.detail["attempt"] == 2
    assert draft.detail["source"] == "on_failure"
