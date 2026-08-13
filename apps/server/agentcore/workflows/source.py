"""工作流的**来源标记**：服务端权威元数据，存在 ``user_workflows.source`` 列上。

以前它挂在 ``definition["source"]`` 里，是个 bug 温床，两个方向都出过事：

- **会丢**。``definition`` 是画布内容，客户端整份提交、整份覆盖是它的正常用法。任何一端
  按「自己知道的字段」重建这份 JSON，别人加的字段就没了——``deliverable`` 的非 form 字段、
  画布 ``slots``、这里的 ``source`` 先后被抹掉过。``source`` 一丢，从一轮协作固化出来的
  工作流就认不出自己是固化来源（按需抽槽不再触发），同一轮重复保存的幂等也跟着失效。
- **能伪造**。客户端能写 definition，就能自己塞一个 ``source``，让手画的工作流冒充固化
  来源去骗抽槽——那条路会拿用户的任务描述去调模型改写。

所以来源搬出 definition：**只由服务端在创建时写入，之后没有任何路径能改它**
（:class:`~agentcore.db.repositories.user_workflows.UserWorkflowRepository` 的 ``update``
根本不收这个参数）。definition 里剩下的 nodes / edges / slots 归用户，服务端只校验不重建
——见 :mod:`agentcore.workflows.definition` 的所有权约定。

``kind`` 是扩展点：今天只有 ``"turn"``（从一轮协作固化）；官方模板复制、手画的都是无来源。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# 从一轮已跑完的协作固化而来（``POST /conversations/{id}/messages/{id}/save-as-workflow`` 写）。
TURN_SOURCE_KIND = "turn"


def turn_source(*, conversation_id: str, message_id: str) -> dict[str, str]:
    """固化来源标记；同时也是「同一轮重复保存」的幂等键（走 ``source`` 列上的索引）。"""
    return {
        "kind": TURN_SOURCE_KIND,
        "conversation_id": conversation_id,
        "message_id": message_id,
    }


def normalize_source(raw: Any) -> dict[str, Any] | None:
    """落库值 → 对外的来源对象；没有 ``kind`` 的一律当作「没有来源」。

    读侧宽容（同 :func:`~agentcore.workflows.slots.slots_from_definition`）：最坏结果是
    这条工作流看起来是手画的，而不是列表页整个炸掉。
    """
    if not isinstance(raw, Mapping):
        return None
    if not str(raw.get("kind") or "").strip():
        return None
    return dict(raw)


def is_turn_sourced(raw: Any) -> bool:
    """这条工作流是不是从一轮协作固化来的（按需抽槽只认这一类）。

    官方模板复制来的本来就带槽位，手画的由用户自己在画布上管——对它们调模型改写任务描述，
    是替用户做他没要过的决定。
    """
    source = normalize_source(raw)
    if source is None or source.get("kind") != TURN_SOURCE_KIND:
        return False
    return bool(source.get("conversation_id")) and bool(source.get("message_id"))
