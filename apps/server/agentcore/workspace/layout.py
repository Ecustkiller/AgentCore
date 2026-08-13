"""``workspaces/`` 盘上布局的单一判据：谁是用户目录，谁是顶层系统段。

``locate`` 回答「某个工作区应该在哪」，本模块回答反过来的问题「盘上现在有哪些目录，
它们分别是什么」。只有扫盘的运维脚本需要后者，而且必须**不查 DB**——需要被扫到的恰恰
是 DB 里查不到的那些（一个文件夹都没建过的纯裸聊用户、folders 行早已消失的幽灵目录）。

判据一律是**白名单**：用户目录必须长成一个规范 UUID。历史上每个扫盘点各自用黑名单
回答同一个问题（「跳过 ``shared`` 就行」），于是与用户目录平级的 ``im/`` 被当成了用户
目录、它下面的 chat UUID 被当成 folder id，一次 ``--apply`` 就能删光全部群聊附件。
黑名单漏一项就是丢数据，而顶层段还会继续增加——白名单则不需要任何人记得回来改。
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from agentcore.config import settings

WORKSPACES_SEGMENT = "workspaces"

# 每个用户目录下的顶层段。用户可见树被 ``tree/`` 圈住，所以用户自己起的文件夹名
# 永远不会和这些撞车（用户完全可以把文件夹叫 ``conv``）。
TREE_SEGMENT = "tree"
CONV_SEGMENT = "conv"
DELETED_SEGMENT = "deleted"
INTERNAL_SEGMENT = "internal"

# 与用户目录**平级**的系统段。列在这里是给读代码的人看的：扫描判据本身不依赖这份
# 清单（见模块 docstring），新增一个段不需要回来改任何扫描逻辑。
IM_SEGMENT = "im"
SHARED_SEGMENT = "shared"

_UUID_SEGMENT_LEN = 36


def workspaces_base_path() -> Path:
    """``<data_dir>/workspaces`` —— 所有扫盘的起点。"""
    return Path(settings.data_dir) / WORKSPACES_SEGMENT


def is_uuid_segment(name: str) -> bool:
    """``name`` 是否是一个规范 UUID 路径段（user id / folder id 的形状）。

    只认规范文本形式（36 字符带连字符）。``UUID()`` 还能解析 32 位裸 hex、花括号、
    ``urn:uuid:`` 前缀等形状——服务端从不产出它们，认了只会白白放宽白名单。
    """
    if len(name) != _UUID_SEGMENT_LEN:
        return False
    try:
        return str(UUID(name)) == name.lower()
    except ValueError:
        return False


def discover_user_ids(workspaces_base: Path | None = None) -> list[str]:
    """盘上真实存在的用户目录，跳过 ``im/`` / ``shared/`` 等平级系统段。"""
    base = workspaces_base if workspaces_base is not None else workspaces_base_path()
    if not base.is_dir():
        return []
    try:
        return sorted(p.name for p in base.iterdir() if p.is_dir() and is_uuid_segment(p.name))
    except OSError:
        return []


def flat_folder_dir(*, user_id: str, folder_id: str, workspaces_base: Path | None = None) -> Path:
    """迁移前那套 ``workspaces/<user>/<folder_id>/`` 平铺落点。

    §5.4 之后没有任何活路径指向这里，但存量迁移和幽灵清理都得先找到它。
    """
    base = workspaces_base if workspaces_base is not None else workspaces_base_path()
    return base / user_id / folder_id


def iter_flat_folder_dirs(workspaces_base: Path | None = None) -> list[tuple[str, str, Path]]:
    """所有 ``workspaces/<user>/<uuid>/`` 目录：``(user_id, folder_id, path)``。

    §5.4 之后活文件夹住在 ``tree/<rel_path>/``，所以还留在这一层的 id 命名目录只剩
    两种可能：尚未迁移的存量，或 folders 行早已消失的幽灵。迁移脚本和清理脚本各要
    一种，但「哪些目录算数」必须是同一份判据——否则清理脚本的黑名单一漏项，删的就
    是别人的数据。
    """
    base = workspaces_base if workspaces_base is not None else workspaces_base_path()
    found: list[tuple[str, str, Path]] = []
    for user_id in discover_user_ids(base):
        try:
            children = sorted(p for p in (base / user_id).iterdir() if p.is_dir())
        except OSError:
            continue
        found.extend(
            (user_id, child.name, child) for child in children if is_uuid_segment(child.name)
        )
    return found
