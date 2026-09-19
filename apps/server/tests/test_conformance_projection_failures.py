"""Independent guard for the ProjectedTurn oracle — failure / abort / gate-lifecycle faces.

Sibling of :mod:`tests.test_conformance_projection` (same contract, same HAND-VERIFIED
discipline: expectations are derived from the vector's events + the designed semantics,
never copied from the committed golden). Split out because this family is what a
correlated oracle+fold bug hides in best: every scenario here folds to a turn whose body
is empty or truncated, so "both sides agree" can mean "both sides silently dropped the
only thing the user was going to see".

Covered here: the representative ``empty_face_*`` pair (empty bubble + structured error),
hot redirect handoff, cascade skip, and the leftover approval-orphaned card that must
never stay pending.
"""

from __future__ import annotations

import pytest

from agentcore.conformance.export import build_fixtures
from agentcore.conformance.vectors import VECTORS
from agentcore.runtime.interaction import GATE_KINDS


def _pending_gates(p: dict) -> list[dict]:
    """Gate interactions still awaiting the user (legacy pendingInteraction slot)."""
    return [
        i
        for i in p["interactions"]
        if i.get("status") == "pending" and i.get("kind") in GATE_KINDS
    ]


@pytest.fixture(scope="module")
def projected() -> dict[str, dict]:
    return {fx["name"]: fx["projected"] for fx in build_fixtures()}


# ── 空泡族（empty_face_*）──────────────────────────────────────────────────────
#
# Every one of these turns ends with an EMPTY body, so the structured `error` is the
# entire user-visible face. Hand-verified per vector: the wire error must survive the
# fold verbatim, and the terminal finish must map to the honest status — `degraded` is
# still a completed turn (the model answered, badly), `error` fails it, `paused` parks
# it. Getting that mapping wrong is exactly the correlated bug the golden can't catch:
# oracle and fold both defaulting an unknown finish to "completed" agree with each other.
_EMPTY_FACE_EXPECTED: dict[str, tuple[str, str, str, str]] = {
    # name: (error code, error message, finishReason, status)
    "empty_face_insufficient_balance": (
        "LLM_INSUFFICIENT_BALANCE",
        "上游账户余额不足，请充值或更换 Key。",
        "error",
        "failed",
    ),
    "empty_face_timeout": (
        "LLM_TIMEOUT",
        "连接超时，请检查网络后重试。",
        "error",
        "failed",
    ),
}


def test_empty_face_family_is_fully_enumerated():
    """A new empty_face_* vector must land in the table above, not slip in uncovered.

    The family exists because these turns have no body to inspect; leaving one of them
    to `pnpm conformance` alone puts it back in the blind spot the family was created for.
    """
    assert set(_EMPTY_FACE_EXPECTED) == {
        n for n in VECTORS if n.startswith("empty_face_")
    }


@pytest.mark.parametrize(
    ("name", "code", "message", "finish", "status"),
    [(n, *v) for n, v in _EMPTY_FACE_EXPECTED.items()],
)
def test_empty_face_keeps_a_face(projected, name, code, message, finish, status):
    p = projected[name]
    # Body really is empty — nothing but `error` stands between the user and a blank bubble.
    assert p["content"] == ""
    assert p["reasoning"] == ""
    assert p["process"] == []
    assert p["runs"] == []
    # The wire error rides through the fold verbatim (no swallow, no rewrite).
    assert p["error"] == {"code": code, "message": message}
    assert p["finishReason"] == finish
    assert p["status"] == status


def test_approval_orphaned_is_settled_not_pending(projected):
    """重启假卡: `interaction_orphaned` must SETTLE the card, not drop it and not leave
    it pending. A restart kills the waiting tool call — the user can never answer it, so
    a fold that keeps `pending` renders a card whose buttons do nothing forever.
    Orphaning is also NOT terminal for the turn: no message_end here → still running."""
    p = projected["approval_orphaned"]
    assert p["status"] == "running"
    assert p["finishReason"] is None
    assert _pending_gates(p) == []
    assert p["interactions"] == [
        {
            "kind": "approval",
            "id": "tc1",
            "status": "orphaned",
            "toolCallId": "tc1",
            "toolName": "code_execute",
            "arguments": {"code": "print(1)"},
        }
    ]
    # The timeline still records WHERE the (now dead) card sat.
    assert [s["kind"] for s in p["process"]] == ["content", "approval"]
    assert p["content"] == "我需要运行代码。"


def test_run_skipped_cascade_is_terminal_not_queued(projected):
    """级联跳过: r1 fails → dependent r2 is never dispatched (`cascade`), and the
    independent r3 dies with the wave (`abort`). Both must fold to the TERMINAL `skipped`
    state — the bug this pins is a graph stuck on "排队中" forever. The failed upstream
    counts as neither, so progress is 0/3 while the turn still closes end_turn."""
    p = projected["multi_agent_run_skipped_cascade"]
    assert p["status"] == "completed"
    assert p["finishReason"] == "end_turn"
    by_id = {r["id"]: r for r in p["runs"]}
    assert by_id["r1"]["status"] == "failed"
    assert by_id["r2"]["status"] == "skipped"
    assert by_id["r3"]["status"] == "skipped"
    assert by_id["r2"]["dependsOn"] == ["r1"]
    assert p["progress"] == {"completed": 0, "total": 3}


def test_run_redirect_hot_continues_the_cancelled_run(projected):
    """跑一半改方向 · 热续写: a salvageable worker is cancelled (`redirect`) and its draft
    continues in a synthesized revision child — linked by `continuesRunId`, NOT
    `replacesRunId`. The two link fields drive different UI (续写 vs 接手), so swapping
    them is a silent, correlated-looking bug."""
    p = projected["multi_agent_run_redirect_hot"]
    assert p["status"] == "completed"
    by_id = {r["id"]: r for r in p["runs"]}
    assert set(by_id) == {"r1", "r2", "r1_rev1"}
    assert by_id["r1"]["status"] == "cancelled"
    rev = by_id["r1_rev1"]
    assert rev["status"] == "completed"
    assert rev["continuesRunId"] == "r1"
    assert rev["replacesRunId"] is None
    assert rev["process"] == [{"kind": "content", "text": "修订稿：按功能差异横评 A/B/C……"}]
    assert p["progress"] == {"completed": 2, "total": 3}
