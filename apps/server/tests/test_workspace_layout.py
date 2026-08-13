"""``workspaces/`` 顶层布局的单一判据：谁是用户目录，谁是平级系统段。

判错的代价极不对称：把用户目录当系统段只是漏迁一个人，把**系统段当用户目录**会让
``cleanup_auto_desk_orphans --apply`` 把 ``im/<chat_id>/`` 下的全部群聊附件 rmtree 掉
（chat id 也是 UUID，在 folders 表里当然查无此行）。所以这里把每个顶层段逐个钉死，
并且钉的是白名单本身——黑名单每漏一项就是一次丢数据。
"""

from pathlib import Path
from uuid import uuid4

import pytest

from agentcore.workspace.layout import (
    CONV_SEGMENT,
    DELETED_SEGMENT,
    IM_SEGMENT,
    INTERNAL_SEGMENT,
    SHARED_SEGMENT,
    TREE_SEGMENT,
    discover_user_ids,
    is_uuid_segment,
    iter_flat_folder_dirs,
)

_UID = "8f14e45f-ceea-467a-9c2f-0b5d1c2a3e4b"


@pytest.mark.parametrize(
    "segment",
    [IM_SEGMENT, SHARED_SEGMENT, TREE_SEGMENT, CONV_SEGMENT, DELETED_SEGMENT, INTERNAL_SEGMENT],
)
def test_no_layout_segment_can_ever_pass_as_an_id(segment: str):
    assert not is_uuid_segment(segment)


def test_only_the_canonical_uuid_text_form_counts():
    assert is_uuid_segment(_UID)
    assert is_uuid_segment(str(uuid4()))
    # 32 位裸 hex / 花括号 / urn 前缀 ``UUID()`` 都认，服务端却从不产出——认了只是白白
    # 放宽白名单。
    assert not is_uuid_segment(_UID.replace("-", ""))
    assert not is_uuid_segment("{" + _UID + "}")
    assert not is_uuid_segment(f"urn:uuid:{_UID}")
    assert not is_uuid_segment("")
    assert not is_uuid_segment("not-a-uuid")


def test_discover_user_ids_skips_the_sibling_infra_segments(tmp_path: Path):
    base = tmp_path / "workspaces"
    (base / _UID).mkdir(parents=True)
    (base / SHARED_SEGMENT).mkdir()
    (base / IM_SEGMENT).mkdir()

    assert discover_user_ids(base) == [_UID]


def test_a_missing_workspaces_dir_is_not_an_error(tmp_path: Path):
    assert discover_user_ids(tmp_path / "nope") == []
    assert iter_flat_folder_dirs(tmp_path / "nope") == []


def test_the_flat_scan_never_descends_into_im(tmp_path: Path):
    """``im/`` 与用户目录平级，其子目录是 chat UUID —— 当成用户目录扫就是删光群聊附件。"""
    base = tmp_path / "workspaces"
    chat_id = str(uuid4())
    (base / IM_SEGMENT / chat_id).mkdir(parents=True)
    (base / SHARED_SEGMENT / str(uuid4())).mkdir(parents=True)

    assert iter_flat_folder_dirs(base) == []


def test_the_flat_scan_finds_id_named_dirs_and_ignores_per_user_segments(tmp_path: Path):
    base = tmp_path / "workspaces"
    folder_id = str(uuid4())
    (base / _UID / folder_id).mkdir(parents=True)
    for segment in (TREE_SEGMENT, CONV_SEGMENT, DELETED_SEGMENT, INTERNAL_SEGMENT):
        (base / _UID / segment / str(uuid4())).mkdir(parents=True)

    assert iter_flat_folder_dirs(base) == [(_UID, folder_id, base / _UID / folder_id)]
