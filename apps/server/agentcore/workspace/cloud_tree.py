"""云文件夹目录树的纯路径代数（双模式工作区 §5.4）。

云文件夹的物理落点由 ``folders.rel_path`` **单一真相源**决定，父子关系由路径前缀
表达——没有 ``parent_id``，「B 在 A 里」就是 ``B.rel_path`` 以 ``A.rel_path + "/"``
开头。本模块只做字符串代数（净化 / 拼接 / 改名 / 移动子树 / 同层去重），不碰盘、
不碰 DB，方便单测。

盘上布局见 :mod:`agentcore.workspace.locate`：可见树在
``workspaces/<user>/tree/<rel_path>/``，与会话 scratch、软删墓碑、隐藏 zone 物理隔离。
"""

from __future__ import annotations

from collections.abc import Iterable

from agentcore.workspace._paths import clean_path_segment
from agentcore.workspace.stage_dirs import AGENTCORE_ROOT

# 名字被净化到空时的兜底（用户可当场改名）。
DEFAULT_FOLDER_NAME = "未命名文件夹"

# 保留名：``AgentCore/`` 是每个工作区根的约定根（``规则/`` ``记忆/`` ``文档/`` 落这
# 里）。只在**非顶层**保留——嵌套的子文件夹若叫这个名字，就会和上层工作区根的约定根撞
# 在同一个物理目录上；而顶层文件夹落在 ``tree/`` 下，那里没有约定根，用户完全可以把自
# 己的文件夹叫 AgentCore（多余的改名就是误伤）。
_RESERVED_CHILD_NAMES: frozenset[str] = frozenset({AGENTCORE_ROOT.casefold()})


def sanitize_folder_name(name: str) -> str:
    """用户输入的文件夹名 → 文件系统安全的单段目录名。

    分隔符（``/`` ``\\``）压成 ``_``——文件夹名只能是一段，嵌套由 ``rel_path``
    表达而不是名字里带斜杠。其余非法字符 / Windows 保留设备名 / 超长的处理与写盘
    路径共用 :func:`clean_path_segment`，避免出现两套净化规则。
    """
    flattened = (name or "").replace("\\", "/").replace("/", "_")
    return clean_path_segment(flattened, empty_fallback=DEFAULT_FOLDER_NAME)


def is_reserved_child_name(name: str) -> bool:
    """嵌套层里该名字是否与上层工作区根的约定目录冲突（须让位加序号）。"""
    return name.casefold() in _RESERVED_CHILD_NAMES


def unique_sibling_name(
    desired: str, taken: Iterable[str], *, nested: bool = False
) -> str:
    """同层禁重名：占用时追加 ``(2)`` / ``(3)`` … 序号后缀。

    比较不区分大小写——Windows / macOS 默认大小写不敏感，``报告`` 与 ``报告``
    在盘上是同一个目录，DB 允许两者并存会让物理 mv 互相覆盖。

    ``nested=True``（挂在某个文件夹下面）时额外避开 :data:`_RESERVED_CHILD_NAMES`。
    """
    used = {t.casefold() for t in taken}

    def free(candidate: str) -> bool:
        if candidate.casefold() in used:
            return False
        return not (nested and is_reserved_child_name(candidate))

    base = desired or DEFAULT_FOLDER_NAME
    if free(base):
        return base
    n = 2
    while True:
        candidate = f"{base} ({n})"
        if free(candidate):
            return candidate
        n += 1


def normalize_rel_path(rel: str | None) -> str:
    """规范成 POSIX、无首尾斜杠的形式；``None`` / 根 → ``""``。"""
    if not rel:
        return ""
    return rel.replace("\\", "/").strip("/")


def rel_path_segments(rel: str | None) -> tuple[str, ...]:
    """拆成层级段；根返回空元组。"""
    normalized = normalize_rel_path(rel)
    if not normalized:
        return ()
    return tuple(seg for seg in normalized.split("/") if seg)


def join_rel_path(parent: str | None, name: str) -> str:
    """把一个已净化的名字挂到 ``parent`` 下（``parent`` 为空 = 挂在树根）。"""
    parent_norm = normalize_rel_path(parent)
    return f"{parent_norm}/{name}" if parent_norm else name


def parent_rel_path(rel: str) -> str:
    """父级 rel_path；顶层文件夹返回 ``""``（树根）。"""
    segments = rel_path_segments(rel)
    return "/".join(segments[:-1])


def rel_path_name(rel: str) -> str:
    """末段（= 用户可见名对应的目录名）。"""
    segments = rel_path_segments(rel)
    return segments[-1] if segments else ""


def is_same_or_descendant(rel: str, ancestor: str) -> bool:
    """``rel`` 是否就是 ``ancestor`` 或落在它的子树里。

    按段比较而非裸字符串前缀——否则 ``报告备份`` 会被误判成 ``报告`` 的子树。
    """
    rel_norm = normalize_rel_path(rel)
    ancestor_norm = normalize_rel_path(ancestor)
    if not ancestor_norm:
        return True
    return rel_norm == ancestor_norm or rel_norm.startswith(f"{ancestor_norm}/")


def ancestor_chain(
    rel: str, placements: Iterable[tuple[str, str]]
) -> list[str]:
    """``rel`` 所在的作用域链，**由外向里**，末位是 ``rel`` 自己（若它在 placements 里）。

    规则 / 记忆沿树继承（双模式工作区 §5.4）要回答「我在哪几层里面」，而唯一能回答的
    就是路径前缀：祖先 = ``rel`` 落在其子树里的那些文件夹。层数升序即由外向里；同层禁
    重名保证一层至多命中一个，顺序因此确定。

    ``placements`` 是 ``(folder_id, rel_path)`` 对（调用方只喂活文件夹）。
    """
    hits = [
        (len(rel_path_segments(other_rel)), fid)
        for fid, other_rel in placements
        if other_rel and is_same_or_descendant(rel, other_rel)
    ]
    hits.sort(key=lambda item: item[0])
    return [fid for _, fid in hits]


def reparent_rel_path(rel: str, *, old_prefix: str, new_prefix: str) -> str:
    """把 ``rel`` 从 ``old_prefix`` 子树整体搬到 ``new_prefix`` 下。

    改名与移动是同一个操作：改名 = 父级不变换末段，移动 = 换父级。子树里每一行都
    过这个函数，所以整棵树在一个事务里保持前缀自洽。
    """
    old_norm = normalize_rel_path(old_prefix)
    new_norm = normalize_rel_path(new_prefix)
    rel_norm = normalize_rel_path(rel)
    if not is_same_or_descendant(rel_norm, old_norm):
        return rel_norm
    if not old_norm:
        return f"{new_norm}/{rel_norm}" if new_norm else rel_norm
    tail = rel_norm[len(old_norm) :].lstrip("/")
    if not tail:
        return new_norm
    return f"{new_norm}/{tail}" if new_norm else tail


def would_nest_into_self(*, source: str, new_parent: str | None) -> bool:
    """移动是否会把一个文件夹塞进自己的子树（须拒）。"""
    return is_same_or_descendant(normalize_rel_path(new_parent), source)


__all__ = [
    "DEFAULT_FOLDER_NAME",
    "ancestor_chain",
    "is_reserved_child_name",
    "is_same_or_descendant",
    "join_rel_path",
    "normalize_rel_path",
    "parent_rel_path",
    "rel_path_name",
    "rel_path_segments",
    "reparent_rel_path",
    "sanitize_folder_name",
    "unique_sibling_name",
    "would_nest_into_self",
]
