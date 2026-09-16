"""md_export tool — thin shell over docs_export.export_markdown_*_path."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from agentcore.tools.builtin.md_export import FORMAT_INVALID_MESSAGE, MdExportTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(workspace: Path) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _document_xml(path: Path) -> str:
    with zipfile.ZipFile(io.BytesIO(path.read_bytes())) as zf:
        return zf.read("word/document.xml").decode("utf-8")


async def test_md_export_docx_writes_sibling_and_warns_missing_image(tmp_path: Path):
    (tmp_path / "note.md").write_text("# Hi\n\n![x](./gone.png)\n", encoding="utf-8")
    result = await MdExportTool().execute(
        {"path": "note.md", "format": "docx"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "note.docx").is_file()
    assert "note.docx" in result.output
    assert "缺图" in result.output
    assert result.metadata is not None
    assert result.metadata["path"] == "note.docx"
    assert result.metadata["format"] == "docx"
    assert [(p.path, p.kind, p.derived_from) for p in result.file_products] == [
        ("note.docx", "docx", "note.md")
    ]


async def test_md_export_pdf_writes_sibling(tmp_path: Path):
    (tmp_path / "note.md").write_text("# Hi\n\n你好世界\n", encoding="utf-8")
    result = await MdExportTool().execute(
        {"path": "note.md", "format": "pdf"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert (tmp_path / "note.pdf").is_file()
    assert (tmp_path / "note.pdf").read_bytes()[:4] == b"%PDF"
    assert "note.pdf" in result.output
    assert "code_execute" not in MdExportTool().schema.description
    assert result.metadata is not None
    assert result.metadata["path"] == "note.pdf"
    assert result.metadata["format"] == "pdf"
    assert [(p.path, p.kind, p.derived_from) for p in result.file_products] == [
        ("note.pdf", "pdf", "note.md")
    ]


async def test_md_export_rejects_non_md(tmp_path: Path):
    result = await MdExportTool().execute(
        {"path": "a.txt", "format": "docx"}, _ctx(tmp_path)
    )
    assert result.success is False
    assert result.error and "Markdown" in result.error


async def test_md_export_docx_layout_official_opts_into_first_line_indent(
    tmp_path: Path,
):
    (tmp_path / "起诉状.md").write_text("# 民事起诉状\n\n原告：张三。\n", encoding="utf-8")

    plain = await MdExportTool().execute(
        {"path": "起诉状.md", "format": "docx"}, _ctx(tmp_path)
    )
    assert plain.success is True
    assert "w:firstLine" not in _document_xml(tmp_path / "起诉状.docx")

    official = await MdExportTool().execute(
        {"path": "起诉状.md", "format": "docx", "layout": "official"},
        _ctx(tmp_path),
    )
    assert official.success is True
    xml = _document_xml(tmp_path / "起诉状.docx")
    assert 'w:firstLineChars="200"' in xml
    assert '<w:jc w:val="center"/>' in xml


async def test_md_export_rejects_unknown_layout(tmp_path: Path):
    (tmp_path / "note.md").write_text("# Hi\n\n正文。\n", encoding="utf-8")
    result = await MdExportTool().execute(
        {"path": "note.md", "format": "docx", "layout": "公文"}, _ctx(tmp_path)
    )
    assert result.success is False
    assert result.error and "layout" in result.error
    assert not (tmp_path / "note.docx").exists()


async def test_md_export_requires_format(tmp_path: Path):
    (tmp_path / "note.md").write_text("# Hi\n\n正文。\n", encoding="utf-8")
    missing = await MdExportTool().execute({"path": "note.md"}, _ctx(tmp_path))
    assert missing.success is False
    assert missing.error == FORMAT_INVALID_MESSAGE
    assert not (tmp_path / "note.docx").exists()
    assert not (tmp_path / "note.pdf").exists()

    bad = await MdExportTool().execute(
        {"path": "note.md", "format": "word"}, _ctx(tmp_path)
    )
    assert bad.success is False
    assert bad.error == FORMAT_INVALID_MESSAGE


def test_md_export_schema_advertises_format_and_layout():
    schema = MdExportTool().schema
    assert schema.name == "md_export"
    fmt = schema.parameters["properties"]["format"]
    assert fmt["enum"] == ["docx", "pdf"]
    assert "format" in schema.parameters["required"]
    assert "path" in schema.parameters["required"]
    layout = schema.parameters["properties"]["layout"]
    assert layout["enum"] == ["standard", "official"]
    assert layout["default"] == "standard"
    assert "正式文书" in layout["description"]
    assert "两端对齐" in layout["description"]
    assert "页码" in layout["description"]
    assert "— n —" in layout["description"]
    assert "layout" not in schema.parameters["required"]


async def test_md_export_pdf_warns_on_image(tmp_path: Path):
    (tmp_path / "note.md").write_text("# Hi\n\n![x](./gone.png)\n", encoding="utf-8")
    result = await MdExportTool().execute(
        {"path": "note.md", "format": "pdf"}, _ctx(tmp_path)
    )
    assert result.success is True
    assert "不嵌入图片" in result.output
