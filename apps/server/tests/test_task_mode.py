"""Deterministic task-mode hints and their turn-envelope placement."""

from agentcore.runtime.resolve.prompt.envelope import render_ceo_turn_envelope
from agentcore.runtime.resolve.task_mode import (
    classify_task_mode,
    render_task_mode_block,
)


def test_single_code_action_selects_fast_path():
    decision = classify_task_mode("帮我修复这个 bug，并跑测试")
    assert decision.mode == "code_fast"


def test_code_question_stays_chat():
    decision = classify_task_mode("解释一下 Python 的 GIL 是什么")
    assert decision.mode == "chat"
    assert render_task_mode_block(decision) == ""


def test_cross_module_parallel_signal_selects_team():
    decision = classify_task_mode("同时修改前后端多个模块并分别验证")
    assert decision.mode == "team"


def test_code_review_selects_review_path():
    decision = classify_task_mode("审查这段 Python 代码的错误处理")
    assert decision.mode == "review"


def test_workspace_continuation_selects_fast_path():
    decision = classify_task_mode("继续", shared_workspace=True)
    assert decision.mode == "code_fast"


def test_task_mode_block_rides_envelope_before_workspace_facts():
    mode = render_task_mode_block(classify_task_mode("修复 TypeScript 类型错误"))
    envelope = render_ceo_turn_envelope(
        task_mode_context=mode,
        workspace_context="<工作区>\n目录：代码仓库\n</工作区>",
    )
    assert '[系统提示]' in envelope
    assert '<任务模式 mode="code_fast">' in envelope
    assert envelope.index("<任务模式") < envelope.index("<工作区>")
