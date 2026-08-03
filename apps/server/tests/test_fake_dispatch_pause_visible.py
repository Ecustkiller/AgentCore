"""Unit tests for ask_user pause / redrive_failed user-visible honesty (案 fake-dispatch C)."""

from agentcore.runtime.engine.ask_user_pause_visible import (
    ASK_USER_PAUSE_USER_VISIBLE,
    claims_dispatch_started,
    ensure_ask_user_pause_body,
    honest_ask_user_message,
)
from agentcore.runtime.turn_interrupt import (
    REDRIVE_FAILED_USER_VISIBLE,
    TurnInterruptReason,
    compose_interrupt_body,
)


def test_claims_dispatch_started_matches_sample_kickoff():
    assert claims_dispatch_started("好，派 3 个 worker 开工高规格版：")
    assert claims_dispatch_started("已派出团队，队员已在做")
    assert claims_dispatch_started("现在开工：")
    assert not claims_dispatch_started("准备派 3 人，确认后开工")
    assert not claims_dispatch_started("请确认风格偏好")


def test_honest_ask_user_message_prefixes_fake_dispatch():
    out = honest_ask_user_message("派 3 个 worker 开工高规格版：")
    assert out.startswith("先确认再派")
    assert "尚未真正开工" in out
    # Already honest → unchanged
    keep = "先确认再派：选哪种风格？"
    assert honest_ask_user_message(keep) == keep


def test_ensure_ask_user_pause_body_forbids_silent_empty():
    assert ensure_ask_user_pause_body("") == ASK_USER_PAUSE_USER_VISIBLE
    assert ensure_ask_user_pause_body("方向：派团队开工") == ASK_USER_PAUSE_USER_VISIBLE
    prior = "上一轮已对齐需求。"
    out = ensure_ask_user_pause_body(prior)
    assert prior in out
    assert ASK_USER_PAUSE_USER_VISIBLE in out


def test_compose_interrupt_redrive_failed_not_silent():
    body = compose_interrupt_body(
        "好，派 3 个 worker 开工高规格版：",
        reason=TurnInterruptReason.REDRIVE_FAILED,
    )
    assert REDRIVE_FAILED_USER_VISIBLE in body
    # USER_STOP still chrome-free
    assert compose_interrupt_body("x", reason=TurnInterruptReason.USER_STOP) == "x"
