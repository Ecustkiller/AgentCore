"""Unit tests for ambient debate steer queue (非阻塞 drain + 掌舵窗口)."""

from agentcore.runtime.debate.steer_queue import (
    close_steer_window,
    enqueue_steer,
    fold_steers,
    open_steer_window,
    peek_steer_count,
    steer_window_open,
    take_steers,
)
from agentcore.runtime.debate.types import RoundDecision


def test_enqueue_take_fifo_and_empty():
    open_steer_window("exec-a")
    enqueue_steer(
        execution_id="exec-a",
        conversation_id="c1",
        decision="continue",
        focus="角度A",
    )
    enqueue_steer(
        execution_id="exec-a",
        conversation_id="c1",
        decision="continue",
        ask="谁兜底？",
        ask_target="pro",
    )
    assert peek_steer_count("exec-a") == 2
    drained = take_steers("exec-a")
    assert len(drained) == 2
    assert drained[0].focus == "角度A"
    assert drained[1].ask == "谁兜底？"
    assert take_steers("exec-a") == []
    assert peek_steer_count("exec-a") == 0
    # 捞干净 ≠ 收场：轮次边界过一个还会有下一个，窗口仍开着。
    assert steer_window_open("exec-a") is True
    close_steer_window("exec-a")


def test_enqueue_rejected_when_window_never_opened():
    """没在跑的 execution（或无活跃用户、没挂边界钩子）→ 不收，别假装排上了队。"""
    assert steer_window_open("exec-cold") is False
    assert (
        enqueue_steer(
            execution_id="exec-cold", conversation_id="c", decision="conclude"
        )
        is None
    )
    assert peek_steer_count("exec-cold") == 0


def test_close_window_rejects_later_steers_and_drops_pending():
    """末轮边界之后（结辩 + 简报数十秒）再点「立即结论」：拒收，且残留条目不常驻内存。"""
    open_steer_window("exec-late")
    assert (
        enqueue_steer(
            execution_id="exec-late", conversation_id="c", decision="continue"
        )
        is not None
    )
    assert close_steer_window("exec-late") == 1  # 未被捞走的条目随关窗丢弃
    assert steer_window_open("exec-late") is False
    assert (
        enqueue_steer(
            execution_id="exec-late", conversation_id="c", decision="conclude"
        )
        is None
    )
    assert peek_steer_count("exec-late") == 0
    # 幂等：重复关窗不报错、无残留。
    assert close_steer_window("exec-late") == 0


def test_fold_empty_is_none():
    assert fold_steers([]) is None


def test_fold_continue_last_wins():
    open_steer_window("exec-b")
    enqueue_steer(execution_id="exec-b", conversation_id="c", decision="continue", focus="旧")
    enqueue_steer(
        execution_id="exec-b",
        conversation_id="c",
        decision="continue",
        focus="新角度",
        ask="问一句",
        ask_target="con",
    )
    boundary = fold_steers(take_steers("exec-b"))
    assert boundary is not None
    assert boundary.decision is RoundDecision.CONTINUE
    assert boundary.focus == "新角度"
    assert boundary.ask == "问一句"
    assert boundary.ask_target == "con"
    close_steer_window("exec-b")


def test_fold_conclude_wins_over_continue():
    open_steer_window("exec-c")
    enqueue_steer(execution_id="exec-c", conversation_id="c", decision="continue", focus="还想辩")
    enqueue_steer(
        execution_id="exec-c",
        conversation_id="c",
        decision="conclude",
        ask="那合规呢？",
    )
    boundary = fold_steers(take_steers("exec-c"))
    assert boundary is not None
    assert boundary.decision is RoundDecision.CONCLUDE
    assert boundary.ask == "那合规呢？"
    assert boundary.focus == ""  # conclude ignores focus
    close_steer_window("exec-c")
