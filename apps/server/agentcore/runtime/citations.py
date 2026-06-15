"""Web 来源（引用）的合并、编号与标注。

一个独立的叶子模块（不依赖 engine / runs / tools），因此 CEO 回合（engine）、
worker 执行器（runs.executor）、委派工具（tools.delegate）与回合管线（pipeline）
都能复用同一套去重/编号逻辑，而不会引入循环导入。

编号 = 来源在 sink 中的 1-based 序号 = 客户端「来源」卡渲染的序号；engine 在 CEO
路径把这个号折回工具输出（:func:`annotate_tool_citations`），让模型按号引用，正文
里的 [n] 始终对得上卡片。worker 路径只做合并、不做标注（见 engine 的 annotate
开关），因为 worker 的本地编号会在汇入回合卡时被重排，标注反而会误导。
"""

from typing import Any

# 每回合「来源」卡的上限——足够支撑任何答案，又不至于把卡片条堆成一堵墙。
_CITATION_CAP = 24


def _citation_key(citation: dict[str, Any]) -> str:
    """来源去重用的归一化键（同一页面被 search + read_url、或被多个引擎命中时合并）：
    去掉 ``#fragment`` 与结尾的 ``/``。"""
    return (citation.get("url") or "").split("#", 1)[0].rstrip("/")


def merge_citations(
    sink: list[dict[str, Any]], new: list[dict[str, Any]]
) -> dict[str, int]:
    """把 ``new`` 合并进 ``sink``（按到达顺序、去重、限量），返回 ``new`` 中那些在
    ``sink`` 里占到位置的来源的 ``{归一化url: 规范编号}`` 映射。

    规范编号是来源在 ``sink`` 中的 1-based 序号——正是客户端渲染的来源卡序号。engine
    把这些编号交给模型（见 :func:`annotate_tool_citations`），使其按一个始终与卡片
    对齐的号引用，而非自己猜序号（A2）。同时被搜到又被读取的页面去重为一张卡并复用其
    编号；被每回合上限丢弃的来源不进映射（没有卡可引）。
    """
    numbers: dict[str, int] = {}
    seen = {_citation_key(c): i + 1 for i, c in enumerate(sink)}
    for c in new:
        key = _citation_key(c)
        if not key:
            continue
        existing = seen.get(key)
        if existing is not None:
            numbers[key] = existing
            continue
        if len(sink) >= _CITATION_CAP:
            continue
        sink.append(c)
        number = len(sink)
        seen[key] = number
        numbers[key] = number
    return numbers


# A2 引用编号：每条 web 工具结果都被标注上 engine 为其来源分配的规范编号（= 来源卡
# 序号）。模型用这些确切编号引用，于是正文 [n] 总能解析到正确的卡片——而非自己猜一个
# 后端按到达顺序独立分配的序号（那在乱序使用、子集、去重与限量时都会错位）。
_CITATION_NUMBER_HINT = (
    "\n\n[来源编号] 上述来源对应的引用号，正文中用方括号角标引用（如 [1]）："
)


def annotate_tool_citations(
    content: str, citations: list[dict[str, Any]], numbers: dict[str, int]
) -> str:
    """把「来源→编号」映射追加到一条工具消息的模型可见输出末尾。

    对 engine 编了号的每个来源列出 ``[n]=url``（按结果自身顺序），让模型按固定编号引用
    而不自己编。被每回合上限丢弃（无编号）的来源略去；结果内重复出现的来源按编号合并。
    若没有任何来源带编号，原样返回 ``content``。
    """
    seen: set[int] = set()
    entries: list[str] = []
    for citation in citations:
        number = numbers.get(_citation_key(citation))
        if number is None or number in seen:
            continue
        seen.add(number)
        entries.append(f"[{number}]={citation.get('url') or ''}")
    if not entries:
        return content
    return f"{content}{_CITATION_NUMBER_HINT}{' '.join(entries)}"
