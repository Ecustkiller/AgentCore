"""工作流槽位：把「上一轮的具体输入」从任务描述里抽出来，留成可替换的占位符。

从一轮协作固化出来的工作流，任务描述里写死的是**那一次**的内容（「调研 Notion 的协作功能
定价」）。不参数化的话，用户下次想换个主题就得进画布逐个节点手改——复用性天生比官方模板
差一截。槽位就是那层参数：``definition`` 顶层挂一份 ``slots``，任务描述里留 ``{{key}}``。

关键设计：**默认值就是原轮的原值**。于是「原样再跑一次」和「换个主题跑」是同一套机制——
跑一次时预填默认值、改不改都行；定时任务不给覆盖值就按默认值跑，正对「每周同一主题出简
报」。也因此 ``slots`` 是可选字段：没有它的工作流（手画的、官方模板复制的、本次改动之前
存的）走的还是原来那条路，一个字符都不会被改写。

与 :mod:`agentcore.workflows.playbook_templates` 的 ``PlaybookTemplateSlot`` 不是一回事：
那个是官方 playbook **复制成我的工作流时**填一次的展开参数（填完就固化进 definition），
这里的是固化产物**每次跑都能换**的运行期参数。

占位符用双花括号。任务描述里出现单花括号是常事（JSON 样例、代码片段、格式说明），单括号
做占位符必然误伤。
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

# 槽位数量宁少勿滥：一屏填得完，超过就不是「换个主题」而是重画工作流了。
MAX_SLOTS = 6
MAX_SLOT_LABEL_CHARS = 24
# 默认值 = 原轮原值，是一段短输入而不是整篇任务描述。
MAX_SLOT_DEFAULT_CHARS = 400
# 跑一次时用户填的覆盖值（比默认值宽，允许贴一段更细的输入）。
MAX_SLOT_VALUE_CHARS = 2000

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-z][a-z0-9_]{0,23})\s*\}\}")


def placeholder(key: str) -> str:
    """``topic`` → ``{{topic}}``（写进任务描述的那个形状）。"""
    return "{{" + key + "}}"


def has_placeholder_syntax(text: str) -> bool:
    """文本里已经有双花括号——参数化必须整体让路，否则来回替换不可逆。"""
    return "{{" in (text or "") or "}}" in (text or "")


def is_slot_key(key: str) -> bool:
    return bool(_KEY_RE.match(key or ""))


def slots_from_definition(definition: Mapping[str, Any] | None) -> list[dict[str, str]]:
    """读 definition 顶层可选 ``slots``，逐条规范化；形状不对的一律当没有。

    读侧一律宽容：老工作流没有这个字段，手改坏的也不该让「跑」这条路炸——最坏结果是没有
    槽位可换，占位符原样留在任务描述里（看得见，不是静默变质）。
    """
    raw = (definition or {}).get("slots")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not is_slot_key(key) or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "key": key,
                "label": str(item.get("label") or key).strip()[:MAX_SLOT_LABEL_CHARS],
                "default": str(item.get("default") or "")[:MAX_SLOT_DEFAULT_CHARS],
            }
        )
        if len(out) >= MAX_SLOTS:
            break
    return out


def slot_definition_errors(raw: Any) -> list[str]:
    """写侧校验（create / update 走的那条）：形状不对就说清楚，不静默丢字段。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        return ["slots 必须是数组"]
    if len(raw) > MAX_SLOTS:
        return [f"slots 数量不能超过 {MAX_SLOTS}"]
    errors: list[str] = []
    seen: set[str] = set()
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            errors.append(f"slots[{i}] 必须是对象")
            continue
        key = str(item.get("key") or "").strip()
        if not is_slot_key(key):
            errors.append(f"slots[{i}] key 须为小写字母开头的 1–24 位小写字母/数字/下划线")
            continue
        if key in seen:
            errors.append(f"槽位 key 重复：`{key}`")
            continue
        seen.add(key)
        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            errors.append(f"槽位 `{key}` 须有非空 label")
        elif len(label.strip()) > MAX_SLOT_LABEL_CHARS:
            errors.append(f"槽位 `{key}` label 不能超过 {MAX_SLOT_LABEL_CHARS} 字")
        default = item.get("default")
        if default is not None and not isinstance(default, str):
            errors.append(f"槽位 `{key}` default 须为字符串")
        elif isinstance(default, str) and len(default) > MAX_SLOT_DEFAULT_CHARS:
            errors.append(f"槽位 `{key}` default 不能超过 {MAX_SLOT_DEFAULT_CHARS} 字")
    return errors


def resolve_slot_values(
    slots: list[dict[str, str]],
    overrides: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """本次跑每个槽位取哪个值：覆盖值 > 默认值（= 原轮原值）。

    空白覆盖值当没填（前端把输入框清空 = 回到原值，不是把占位符换成空串）；不认识的覆盖
    键直接忽略——definition 才是槽位清单的事实源。
    """
    values: dict[str, str] = {}
    for slot in slots:
        key = slot["key"]
        raw = (overrides or {}).get(key)
        text = str(raw).strip()[:MAX_SLOT_VALUE_CHARS] if raw is not None else ""
        values[key] = text or slot.get("default", "")
    return values


def fill_placeholders(text: str, values: Mapping[str, str]) -> str:
    """把 ``{{key}}`` 换成本次的值；没声明的占位符原样留着（那就是普通文本）。"""
    if not text or not values:
        return text
    return _PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), m.group(0)), text)
