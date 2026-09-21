"""DeepSeek in-history extra system: live catalog/rules without rewriting node 0.

``messages[0]`` stays the frozen chat header. When this turn's compose differs
only in ``<设定>`` / ``<按需目录>``, the extra system is those blocks (plus a
one-line replacement fact). Base / core / anything else still dumps the full
current compose — same as before this delta.
"""

from __future__ import annotations

import re

# 当场事实：窗里会同时存在 node 0 旧块与这一份。产品合同（听哪份目录/设定）。
# 不写 messages[0]、不写禁止句。测试不钉这句字面。
IN_HISTORY_REPLACE_LEAD = "以下替换此前同名块。"

_REPLACEABLE_TAGS = ("设定", "按需目录")


def _block_pattern(tag: str) -> re.Pattern[str]:
    return re.compile(rf"<{tag}>.*?</{tag}>", re.DOTALL)


def extract_named_block(text: str, tag: str) -> str:
    """First ``<tag>…</tag>`` in ``text``, or empty."""
    match = _block_pattern(tag).search(text or "")
    return match.group(0).strip() if match else ""


def _without_replaceable_blocks(text: str) -> str:
    rest = text or ""
    for tag in _REPLACEABLE_TAGS:
        rest = _block_pattern(tag).sub("", rest)
    return re.sub(r"\n{2,}", "\n\n", rest).strip()


def in_history_system_delta(frozen: str, current: str) -> str:
    """Extra ``role: system`` to append after history, or empty.

    Identical compose → empty. Catalog / always-on rules only → those blocks.
    Any other drift (shared base, CEO core, unexpected sections) → full ``current``.
    """
    frozen_s = (frozen or "").strip()
    current_s = (current or "").strip()
    if not current_s or frozen_s == current_s:
        return ""
    if _without_replaceable_blocks(frozen_s) != _without_replaceable_blocks(current_s):
        return current_s
    blocks: list[str] = []
    for tag in _REPLACEABLE_TAGS:
        old = extract_named_block(frozen_s, tag)
        new = extract_named_block(current_s, tag)
        if old == new:
            continue
        blocks.append(new if new else f"<{tag}>\n</{tag}>")
    if not blocks:
        return ""
    return IN_HISTORY_REPLACE_LEAD + "\n" + "\n\n".join(blocks)
