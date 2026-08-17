"""Cloud sandbox Python list is a single file; consumers must read it.

Hand-copied inventories in Dockerfile / code_execute / docs / data_file_landing
drifted (pillow vs Pillow). These tests lock the wiring: the list file is the
only inventory, and editing a consumer copy in isolation goes red.
"""

from __future__ import annotations

import re
from pathlib import Path

from agentcore.runtime.skills import build_system_skill_registry
from agentcore.tools.builtin.code_execute import code_execute_description
from agentcore.tools.sandbox.cloud_python import (
    DOCKER_CONTEXT_PATH,
    LIST_FILE,
    format_cloud_python_libs,
    load_cloud_python_packages,
)

_REPO = Path(__file__).resolve().parents[3]
_DOCKERFILE = _REPO / "apps" / "server" / "Dockerfile"
_CODE_EXECUTE = (
    _REPO / "apps" / "server" / "agentcore" / "tools" / "builtin" / "code_execute.py"
)
_DATA_FILE_LANDING = (
    _REPO
    / "apps"
    / "server"
    / "agentcore"
    / "runtime"
    / "skills"
    / "data_file_landing.py"
)
_DEPLOY_DOC = _REPO / "docs" / "05-平台与运维" / "部署拓扑与环境.md"

# Explicitly rejected additions (also in the list-file header). Not an inventory.
_REJECTED = frozenset(
    {
        "camelot",
        "pymupdf",
        "pytesseract",
        "geopandas",
        "scipy",
        "pyarrow",
        "xlrd",
        "py7zr",
    }
)

_PIP_FROM_LIST = re.compile(
    r"pip install\s+[^\n]*-r\s+\S*cloud_python\.txt",
    re.IGNORECASE,
)


def _token_hits(line: str, packages: tuple[str, ...]) -> list[str]:
    return [
        name
        for name in packages
        if re.search(rf"(^|[\s,、\\=/]){re.escape(name)}([\s,、\\]|$)", line)
    ]


def _dockerfile_errors(text: str) -> list[str]:
    errors: list[str] = []
    if DOCKER_CONTEXT_PATH not in text:
        errors.append("Dockerfile does not reference the list file path")
    if _PIP_FROM_LIST.search(text) is None:
        errors.append("Dockerfile pip install does not use -r cloud_python.txt")
    packages = load_cloud_python_packages()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        hits = _token_hits(stripped, packages)
        if hits:
            errors.append(
                f"Dockerfile inlines {hits!r}; package names belong only in the list file"
            )
    return errors


def _literal_errors(source: str, *, where: str) -> list[str]:
    errors: list[str] = []
    for name in load_cloud_python_packages():
        if name in source:
            errors.append(f"{where} hardcodes {name!r}")
    return errors


def test_list_file_is_the_inventory():
    assert LIST_FILE.is_file()
    packages = load_cloud_python_packages()
    assert packages
    assert "pdfplumber" in packages
    assert "python-pptx" in packages
    for spec in packages:
        assert not re.search(r"[=<>~]", spec), spec
        assert spec.lower() not in _REJECTED, spec
    # Comments mention vetoes; requirement lines must not.
    raw = LIST_FILE.read_text(encoding="utf-8")
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        assert stripped.split("#", 1)[0].strip() in packages


def test_server_description_is_rendered_from_the_list():
    libs = format_cloud_python_libs()
    desc = code_execute_description("server")
    assert f"沙箱 Python 已预装常用文档 / 数据库：{libs}（画图含中文时先设置" in desc
    for name in load_cloud_python_packages():
        assert name in desc
    # Local / catalog copies must not advertise the cloud inventory.
    assert libs not in code_execute_description("local")
    assert libs not in code_execute_description()


def test_dockerfile_installs_from_the_list_file():
    text = _DOCKERFILE.read_text(encoding="utf-8")
    assert _dockerfile_errors(text) == []


def test_code_execute_source_has_no_inventory_literals():
    src = _CODE_EXECUTE.read_text(encoding="utf-8")
    assert "format_cloud_python_libs" in src
    assert _literal_errors(src, where="code_execute.py") == []


def test_data_file_landing_names_no_sandbox_libs():
    src = _DATA_FILE_LANDING.read_text(encoding="utf-8")
    assert _literal_errors(src, where="data_file_landing.py") == []
    skill = build_system_skill_registry().get("data_file_landing")
    assert skill is not None
    body = skill.body
    assert "抽表" in body
    assert "按页抽文本" in body
    assert "工具描述" in body


def test_deploy_doc_points_at_the_list_file():
    text = _DEPLOY_DOC.read_text(encoding="utf-8")
    assert "cloud_python.txt" in text
    # Old slash-separated inventory must not return.
    assert "python-pptx / python-docx / openpyxl" not in text
    assert _literal_errors(
        # Only the 镜像 bullet was the copy; the pptx smoke step may name one lib.
        text.split("**部署后人工验证清单**")[0],
        where="部署拓扑 镜像段",
    ) == []


def test_inline_dockerfile_list_goes_red():
    text = _DOCKERFILE.read_text(encoding="utf-8")
    broken = text.replace(
        'pip install --no-cache-dir -i "${PYPI_INDEX}" -r /tmp/cloud_python.txt',
        'pip install --no-cache-dir -i "${PYPI_INDEX}" python-pptx pillow',
    )
    assert broken != text
    errors = _dockerfile_errors(broken)
    assert errors, "inlining packages in Dockerfile must fail the gate"


def test_hardcoded_description_list_goes_red():
    src = _CODE_EXECUTE.read_text(encoding="utf-8")
    broken = src.replace(
        "{format_cloud_python_libs()}",
        "python-pptx、pillow",
    )
    assert broken != src
    errors = _literal_errors(broken, where="code_execute.py")
    assert errors, "hand-copying names into code_execute.py must fail the gate"


def test_skill_naming_a_lib_goes_red():
    src = _DATA_FILE_LANDING.read_text(encoding="utf-8")
    broken = src.replace("抽表专用库", "pypdf")
    assert broken != src
    errors = _literal_errors(broken, where="data_file_landing.py")
    assert errors, "naming a sandbox lib in data_file_landing must fail the gate"
