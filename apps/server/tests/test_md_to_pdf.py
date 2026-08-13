"""Tests for deterministic Markdown → PDF conversion."""

from __future__ import annotations

import re
import zlib
from pathlib import Path

import pytest

import agentcore.docs_export.md_to_pdf as md_to_pdf_mod
from agentcore.docs_export.md_to_pdf import (
    convert_markdown_to_pdf,
    discover_cjk_font,
    pdf_path_for_markdown,
)
from agentcore.docs_export.workspace_export import ExportMarkdownError, export_markdown_to_pdf_path
from agentcore.tools.sandbox import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

_FIXTURE_MD = """# 标题一

## 小节二

这是一段含 [链接](https://example.com) 与 **加粗** 的正文。

- 无序甲
- 无序乙

1. 有序一
2. 有序二

```python
print("hello")
```

| 列A | 列B |
| --- | --- |
| 1 | 2 |

![示意图](./assets/chart.png)
"""


def test_fpdf_is_lazy_until_convert(monkeypatch: pytest.MonkeyPatch) -> None:
    """Importing the module must not require fpdf2 until first convert."""
    monkeypatch.setattr(md_to_pdf_mod, "_FPDF", None)
    assert md_to_pdf_mod._FPDF is None
    out = convert_markdown_to_pdf("# hi")
    assert md_to_pdf_mod._FPDF is not None
    assert out.pdf_bytes[:4] == b"%PDF"


def test_pdf_path_for_markdown():
    assert pdf_path_for_markdown("报告.md") == "报告.pdf"
    assert pdf_path_for_markdown("docs/a.markdown") == "docs/a.pdf"
    assert pdf_path_for_markdown("noext") == "noext.pdf"


def test_convert_markdown_structure_and_image_warning():
    result = convert_markdown_to_pdf(_FIXTURE_MD)
    assert result.pdf_bytes[:4] == b"%PDF"
    assert b"PDF" in result.pdf_bytes[:8] or result.pdf_bytes.startswith(b"%PDF")
    # Chinese content + code should be embedded when a CJK font is available.
    # Always assert image skip warning (MVP does not embed images).
    assert any("不嵌入图片" in w and "chart.png" in w for w in result.warnings)
    # PDF must be non-trivial size.
    assert len(result.pdf_bytes) > 200


def test_missing_cjk_font_emits_explicit_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(md_to_pdf_mod, "discover_cjk_font", lambda candidates=None: None)
    result = convert_markdown_to_pdf("# 中文标题\n\n正文")
    assert result.pdf_bytes[:4] == b"%PDF"
    assert any("CJK" in w or "中文" in w for w in result.warnings)
    assert any("方框" in w for w in result.warnings)


def test_discover_cjk_font_respects_candidates(tmp_path: Path) -> None:
    missing = tmp_path / "nope.ttf"
    assert discover_cjk_font([missing]) is None
    real = discover_cjk_font()
    # On CI without fonts this may be None — that's OK; just don't crash.
    assert real is None or real.is_file()


_PLEADING_MD = """# 民事起诉状

## 诉讼请求

原告：张三，男，1980 年生。

- 证据一
"""


def _text_positions(pdf_bytes: bytes) -> list[tuple[float, float]]:
    """Decompressed content-stream ``Td`` origins — one per rendered text line."""
    chunks: list[str] = []
    for raw in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", pdf_bytes, re.S):
        try:
            chunks.append(zlib.decompress(raw).decode("latin-1"))
        except zlib.error:
            continue
    return [
        (float(x), float(y))
        for x, y in re.findall(r"([\d.]+) ([\d.]+) Td", "\n".join(chunks))
    ]


def test_default_layout_centers_h1_without_first_line_indent():
    """默认档与 md_to_docx 同口径：大标题居中，正文左边界与二级标题、列表齐平。"""
    h1, h2, body, item = _text_positions(convert_markdown_to_pdf(_PLEADING_MD).pdf_bytes)
    assert h2[0] == body[0] == item[0]
    assert h1[0] > body[0] + 20  # 居中 → 起笔远离左边界


def test_official_layout_indents_body_first_line():
    """公文档：只有正文首行右移两字（11pt 正文 → 22pt），标题与列表不动。"""
    plain = _text_positions(convert_markdown_to_pdf(_PLEADING_MD).pdf_bytes)
    official = _text_positions(
        convert_markdown_to_pdf(_PLEADING_MD, layout="official").pdf_bytes
    )
    assert official[2][0] == pytest.approx(plain[2][0] + 2 * 11, abs=0.01)
    assert [official[i] for i in (0, 1, 3)] == [plain[i] for i in (0, 1, 3)]


def test_layout_never_inferred_from_body_text():
    """同一份公文正文，不传档位就必须与技术文档一个排版——禁止内容启发式。"""
    plain = _text_positions(convert_markdown_to_pdf(_PLEADING_MD).pdf_bytes)
    explicit = _text_positions(
        convert_markdown_to_pdf(_PLEADING_MD, layout="standard").pdf_bytes
    )
    assert plain == explicit


@pytest.mark.asyncio
async def test_export_markdown_to_pdf_path_layout_defaults_to_standard(tmp_path: Path):
    """HTTP「导出 PDF」路径不传 layout，落盘文件必须没有首行缩进。"""
    root = tmp_path / "ws"
    root.mkdir()
    (root / "起诉状.md").write_text(_PLEADING_MD, encoding="utf-8")
    backend = ServerWorkspace(root=root, sandbox=SubprocessSandbox())

    await export_markdown_to_pdf_path(backend, "起诉状.md")
    plain = _text_positions((root / "起诉状.pdf").read_bytes())
    await export_markdown_to_pdf_path(backend, "起诉状.md", layout="official")
    official = _text_positions((root / "起诉状.pdf").read_bytes())

    assert official[2][0] > plain[2][0]


@pytest.mark.asyncio
async def test_export_markdown_to_pdf_path_writes_sibling(tmp_path: Path):
    root = tmp_path / "ws"
    root.mkdir()
    (root / "报告.md").write_text("# Hi\n\n你好\n", encoding="utf-8")

    backend = ServerWorkspace(root=root, sandbox=SubprocessSandbox())
    out = await export_markdown_to_pdf_path(backend, "报告.md")
    assert out.output_path == "报告.pdf"
    assert (root / "报告.pdf").is_file()
    assert out.size_bytes == (root / "报告.pdf").stat().st_size
    assert (root / "报告.pdf").read_bytes()[:4] == b"%PDF"


@pytest.mark.asyncio
async def test_export_markdown_to_pdf_path_missing_source(tmp_path: Path):
    backend = ServerWorkspace(root=tmp_path / "ws", sandbox=SubprocessSandbox())
    (tmp_path / "ws").mkdir()
    with pytest.raises(ExportMarkdownError, match="不存在"):
        await export_markdown_to_pdf_path(backend, "nope.md")
