"""部署链必须在停-api 窗口内跑盘上迁移。

两个脚本都曾**完全不调** ``scripts/migrate_workspace_tree.py``（全仓无调用点），后果不是
「迁移晚一点」而是永久丢文件：``resolve_workspace_root`` 无条件 ``mkdir``，新 api 一接
流量，第一个打开云文件夹的用户就把搬迁目标建成空目录；搬迁「目标已存在就跳过、绝不合并」，
运维事后补跑一律被判 skipped，文件永远停在旧的平铺目录里。

所以这里钉的是**顺序**，不只是「有没有调」：alembic 回填 rel_path 在前，tree 搬迁居中，
读 ``tree/<rel_path>/`` 的 project-docs 在后，全部在起 api 之前。
"""

from pathlib import Path

import pytest

_DEPLOY_SCRIPTS = Path(__file__).resolve().parents[3] / "deploy" / "scripts"


def _command_lines(path: Path) -> list[str]:
    """只留会执行的行——顺序断言不能被文件头那段流程说明注释带偏。"""
    return [
        line
        for line in path.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    ]


def _first_containing(lines: list[str], needle: str) -> int:
    for i, line in enumerate(lines):
        if needle in line:
            return i
    raise AssertionError(f"部署脚本里找不到 {needle!r}")


def _first_exact(lines: list[str], text: str) -> int:
    for i, line in enumerate(lines):
        if line.strip() == text:
            return i
    raise AssertionError(f"部署脚本里找不到整行 {text!r}")


@pytest.mark.parametrize(
    ("filename", "stop_api", "start_api"),
    [
        (
            "finish-server.sh",
            '"${COMPOSE[@]}" stop api 2>/dev/null || true',
            '"${COMPOSE[@]}" up -d',
        ),
        ("deploy-server.sh", "dc stop api 2>/dev/null || true", "dc up -d"),
    ],
)
def test_disk_migrations_run_between_alembic_and_starting_the_api(
    filename: str, stop_api: str, start_api: str
):
    lines = _command_lines(_DEPLOY_SCRIPTS / filename)

    stopped = _first_exact(lines, stop_api)
    alembic = _first_containing(lines, "alembic upgrade head")
    tree = _first_containing(lines, "scripts/migrate_workspace_tree.py")
    docs = _first_containing(lines, "scripts/migrate_project_docs.py")
    started = _first_exact(lines, start_api)

    assert stopped < alembic < tree < docs < started
