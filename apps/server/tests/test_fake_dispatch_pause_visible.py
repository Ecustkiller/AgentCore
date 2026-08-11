"""Unit tests for ask_user pause / redrive_failed user-visible honesty (案 fake-dispatch C)."""

from agentcore.runtime.engine.ask_user_pause_visible import (
    ASK_USER_PAUSE_USER_VISIBLE,
    claims_dispatch_started,
    claims_install_or_deps_ready,
    ensure_ask_user_pause_body,
    honest_ask_user_message,
    is_hollow_ask_pause,
    structured_confirm_restatement,
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


def test_claims_install_or_deps_ready_matches_ac890_sample():
    assert claims_install_or_deps_ready("依赖已经装完，派两个队员继续")
    assert claims_install_or_deps_ready("环境已就绪，可以开工")
    assert claims_install_or_deps_ready("装完了，下一步派工")
    assert not claims_install_or_deps_ready("依赖还在装，先确认路径")
    assert not claims_install_or_deps_ready("选哪种风格再开工？")


def test_honest_ask_user_message_prefixes_fake_dispatch():
    out = honest_ask_user_message("派 3 个 worker 开工高规格版：")
    assert out.startswith("先确认再派")
    assert "尚未真正开工" in out
    # Already honest → unchanged
    keep = "先确认再派：选哪种风格？"
    assert honest_ask_user_message(keep) == keep


def test_honest_ask_user_message_strips_install_ready_claim():
    # ac890 ⑥B：卡面不得保留「装完了」再叠尚未开工
    out = honest_ask_user_message("依赖已经装完，派两个队员")
    assert "装完" not in out
    assert "就绪" not in out
    assert "确认" in out


def test_ensure_ask_user_pause_body_forbids_silent_empty():
    # 204dcfda：空泡必须补可见脸（禁 reply_chars=0）
    assert ensure_ask_user_pause_body("") == ASK_USER_PAUSE_USER_VISIBLE
    assert ensure_ask_user_pause_body("   ") == ASK_USER_PAUSE_USER_VISIBLE


def test_ensure_ask_user_pause_body_appends_not_replaces():
    # 32b78c65：已有短问 / kickoff 文案时追加，禁止整段替换掩盖原意
    short = "选哪种风格再开工？"
    out_short = ensure_ask_user_pause_body(short)
    assert out_short.startswith(short)
    assert ASK_USER_PAUSE_USER_VISIBLE in out_short
    assert out_short != ASK_USER_PAUSE_USER_VISIBLE

    kickoff = "方向：派团队开工"
    out_kick = ensure_ask_user_pause_body(kickoff)
    assert kickoff in out_kick
    assert ASK_USER_PAUSE_USER_VISIBLE in out_kick
    assert out_kick != ASK_USER_PAUSE_USER_VISIBLE

    claim = "好，派 3 个 worker 开工高规格版："
    out_claim = ensure_ask_user_pause_body(claim)
    assert claim in out_claim
    assert ASK_USER_PAUSE_USER_VISIBLE in out_claim

    prior = "上一轮已对齐需求。"
    out = ensure_ask_user_pause_body(prior)
    assert prior in out
    assert ASK_USER_PAUSE_USER_VISIBLE in out

    keep = f"先确认再派：{short}"
    assert ensure_ask_user_pause_body(keep) == keep


def test_ensure_ask_user_pause_body_forbids_ready_vs_not_started_stack():
    # ac890 ⑥B：禁「装完了/依赖就绪」与「尚未真正开工」并列
    ready = "依赖已经装完，派两个队员继续推进。"
    out = ensure_ask_user_pause_body(ready)
    assert out == ASK_USER_PAUSE_USER_VISIBLE
    assert "装完" not in out

    stacked = f"{ready}\n\n{ASK_USER_PAUSE_USER_VISIBLE}"
    assert ensure_ask_user_pause_body(stacked) == ASK_USER_PAUSE_USER_VISIBLE


def test_is_hollow_ask_pause_matches_empty_and_constant():
    assert is_hollow_ask_pause("")
    assert is_hollow_ask_pause("   ")
    assert is_hollow_ask_pause(ASK_USER_PAUSE_USER_VISIBLE)
    assert not is_hollow_ask_pause("选哪种风格再开工？")


def test_ensure_ask_user_pause_body_restates_card_defaults_over_hollow():
    # 53f08：空/空洞 pause + 卡上路径 default → 复述路径，禁只剩 18 字模板
    questions = [
        {
            "id": "q0",
            "prompt": "仓库路径",
            "kind": "choice",
            "options": [
                {"label": "当前目录建仓", "path": "C:/Work/demo-repo"},
                {"label": "另选文件夹"},
            ],
            "multiple": False,
            "default": "当前目录建仓",
        }
    ]
    assert "路径=" in structured_confirm_restatement(questions)
    out_empty = ensure_ask_user_pause_body("", questions=questions)
    assert "当前目录建仓" in out_empty
    assert "C:/Work/demo-repo" in out_empty
    assert ASK_USER_PAUSE_USER_VISIBLE in out_empty
    assert out_empty != ASK_USER_PAUSE_USER_VISIBLE

    out_hollow = ensure_ask_user_pause_body(ASK_USER_PAUSE_USER_VISIBLE, questions=questions)
    assert "当前目录建仓" in out_hollow
    assert out_hollow != ASK_USER_PAUSE_USER_VISIBLE


def test_ensure_ask_user_pause_body_keeps_prior_structured_over_hollow():
    # d4d5：上轮已有结构化确认选项时，空模板不得冲掉
    prior = (
        "交付状态：尚未开工（等待目录恢复）。请选择："
        "重新打开/授权 / 告知新路径 / 改审名册其他项目，然后回复「已恢复」。"
    )
    out = ensure_ask_user_pause_body(
        ASK_USER_PAUSE_USER_VISIBLE,
        prior_visible=prior,
    )
    assert "重新打开/授权" in out
    assert "已恢复" in out
    assert out != ASK_USER_PAUSE_USER_VISIBLE


def test_compose_interrupt_redrive_failed_not_silent():
    body = compose_interrupt_body(
        "好，派 3 个 worker 开工高规格版：",
        reason=TurnInterruptReason.REDRIVE_FAILED,
    )
    assert REDRIVE_FAILED_USER_VISIBLE in body
    # USER_STOP still chrome-free
    assert compose_interrupt_body("x", reason=TurnInterruptReason.USER_STOP) == "x"
