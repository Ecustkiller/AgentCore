"""材料索引格式（零 LLM）；约定柜扫描已卸。"""

from __future__ import annotations

from agentcore.runtime.debate.research_dossier import (
    dossier_file_hint,
    format_research_dossier_index,
)


def test_format_research_dossier_index_shape():
    assert format_research_dossier_index([]) == ""
    text = format_research_dossier_index(["notes/a.md", "notes/b.md"])
    assert text.startswith("【工作区材料索引】")
    assert "非全文" in text
    assert "read" in text
    assert "选读" in text or "勿无差别" in text
    assert "- notes/a.md" in text
    assert "- notes/b.md" in text


def test_format_research_dossier_index_file_hints():
    hint = dossier_file_hint("notes/法律透镜报告.md", "# 法律要点\n\n正文……")
    assert "法律" in hint
    assert "字" in hint
    text = format_research_dossier_index(
        ["notes/法律透镜报告.md"],
        file_hints={"notes/法律透镜报告.md": hint},
    )
    assert "法律透镜报告.md（" in text
    assert "法律要点" in text
