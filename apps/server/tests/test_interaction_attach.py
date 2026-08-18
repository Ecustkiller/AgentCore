"""R-16 同卡合并：InteractionRegistry.attach 附加 waiter 与 resolve 广播。

多个 worker 对同 conversation 的相同 question 并发 escalate 时，后端合并到同一张
escalation 卡（attach 附加 waiter），用户答一次、多 worker 共享同一答案；不同
question / kind / 会话不合并，已结算卡不可再 attach。
"""

from __future__ import annotations

import asyncio

import pytest

from agentcore.runtime.interaction import InteractionKind, InteractionRegistry


async def test_attach_merges_extra_waiter_and_broadcasts_result() -> None:
    reg = InteractionRegistry()
    fut = reg.create(
        "e1", "conv1", kind=InteractionKind.ESCALATION, payload={"question": "Q1"}
    )
    w1 = reg.attach("e1", "conv1", kind=InteractionKind.ESCALATION)
    w2 = reg.attach("e1", "conv1", kind=InteractionKind.ESCALATION)
    assert w1 is not None and w2 is not None

    assert reg.resolve("e1", {"answer": "OK"}, conversation_id="conv1") is True
    assert fut.result() == {"answer": "OK"}
    assert w1.result() == {"answer": "OK"}
    assert w2.result() == {"answer": "OK"}


async def test_attach_rejects_kind_mismatch_and_conversation_mismatch() -> None:
    reg = InteractionRegistry()
    reg.create("e1", "conv1", kind=InteractionKind.ESCALATION, payload={})
    assert reg.attach("e1", "conv1", kind=InteractionKind.APPROVAL) is None
    assert reg.attach("e1", "conv2", kind=InteractionKind.ESCALATION) is None


async def test_attach_after_resolve_returns_none_and_resolve_is_idempotent() -> None:
    reg = InteractionRegistry()
    reg.create("e1", "conv1", kind=InteractionKind.ESCALATION, payload={})
    assert reg.resolve("e1", "v", conversation_id="conv1") is True
    # 已结算：attach 拒绝、重复 resolve 返回 False
    assert reg.attach("e1", "conv1", kind=InteractionKind.ESCALATION) is None
    assert reg.resolve("e1", "v2", conversation_id="conv1") is False


async def test_attach_waiter_receives_assumption_result() -> None:
    """合并 waiter 收到与主卡一致的 use_assumption 结果（按假设继续语义同口径）。"""
    reg = InteractionRegistry()
    fut = reg.create("e1", "conv1", kind=InteractionKind.ESCALATION, payload={})
    w = reg.attach("e1", "conv1", kind=InteractionKind.ESCALATION)
    assert w is not None
    assert reg.resolve("e1", {"use_assumption": True}, conversation_id="conv1") is True
    assert fut.result() == {"use_assumption": True}
    assert w.result() == {"use_assumption": True}


@pytest.mark.anyio
async def test_attach_waiter_unblocks_same_resolve() -> None:
    """主 Future 与附加 waiter 在 resolve 时同时解除（共享同一卡的一次结算）。"""
    reg = InteractionRegistry()
    fut = reg.create("e1", "conv1", kind=InteractionKind.ESCALATION, payload={})
    w = reg.attach("e1", "conv1", kind=InteractionKind.ESCALATION)
    assert w is not None

    async def resolve_later() -> None:
        await asyncio.sleep(0.01)
        assert reg.resolve("e1", "done", conversation_id="conv1") is True

    task = asyncio.create_task(resolve_later())
    main_result = await fut
    waiter_result = await w
    await task
    assert main_result == "done"
    assert waiter_result == "done"
