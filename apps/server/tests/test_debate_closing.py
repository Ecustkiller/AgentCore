"""结辩收束（P4·阶段化发言角色，辩论编排设计.md §4-2.4「方案甲」）prompt 契约自测（per-PR 零 LLM）。

方案甲的验收面是【prompt 契约】：结辩环节喂给辩手的 feedback 必须把「结辩」这个阶段角色讲清楚——
只讲胜负手（本方最强论点 + 为何对方反驳不成立）、【禁止引入新论据 / 新事实】、且长度显著收紧（阶段化
长度预算：立论 400–600 字 → 结辩 150–250 字）。结辩质量本身需真模型 / eval 验，但「阶段约束是否注入」
是可无 LLM 断言的契约。这里直接调纯函数（`closing_task` / `closing_context_blocks`）断言约束在场。
"""

from agentcore.runtime.debate import DebateConfig, DebateForm, DebateSide, RoundPolicy
from agentcore.tools.builtin.debate.prompt import closing_context_blocks, closing_task
from agentcore.tools.builtin.debate.schema import CLOSING_LENGTH_HINT, LENGTH_HINT


def _two_sides() -> list[DebateSide]:
    return [
        DebateSide(key="pro", name="正方", stance="支持做 X"),
        DebateSide(key="con", name="反方", stance="反对做 X"),
    ]


def _config() -> DebateConfig:
    return DebateConfig(
        motion="该不该做 X",
        form=DebateForm.DEBATE,
        sides=_two_sides(),
        policy=RoundPolicy(thorough=True, max_rounds=5),
    )


def test_closing_task_demands_winning_moves_and_bans_new_arguments():
    """结辩 feedback：点明是【最后陈词】、要求只讲胜负手、且明令【不得引入新论据 / 新事实】。"""
    fb = closing_task(_config(), _two_sides()[0])
    assert "结辩" in fb and "最后陈词" in fb
    assert "胜负手" in fb
    # 结辩收束的核心约束：不许把结辩当又一轮立论、临门抛新论据。
    assert "不得引入" in fb and "新论据" in fb


def test_closing_task_carries_phased_length_budget():
    """阶段化长度预算：结辩注入更紧的长度预算（CLOSING_LENGTH_HINT），且不再是立论的 LENGTH_HINT。"""
    fb = closing_task(_config(), _two_sides()[0])
    assert CLOSING_LENGTH_HINT in fb
    # 结辩比立论更短——用的是结辩预算而非立论预算（防两处口径混用）。
    assert LENGTH_HINT not in fb
    assert CLOSING_LENGTH_HINT != LENGTH_HINT


def test_closing_context_blocks_shows_closing_framing():
    """结辩节点的『收到的上下文』：task 块复用 feedback + closing 通道块纯环节标记。"""
    fb = closing_task(_config(), _two_sides()[0])
    blocks = closing_context_blocks(_config(), _two_sides()[0], fb)
    assert [b.channel for b in blocks] == ["task", "closing"]
    assert blocks[0].body == fb
    assert "结辩" in blocks[0].heading
    assert "结辩" in blocks[1].heading
    assert "结辩" in blocks[1].body
    # closing 通道不再复述指令（胜负手 / 禁新论据只在 task/feedback）
    assert "胜负手" not in blocks[1].body
    assert "新论据" not in blocks[1].body
