"""调研正文 ``#rN`` 锚写入（零 LLM）；约定柜预登记已卸。"""

from __future__ import annotations

from agentcore.runtime.debate.research_dossier import (
    dossier_label_from_path,
    ensure_research_file_anchors,
    extract_research_ledger_anchors,
    format_research_dossier_index,
)


def test_dossier_label_from_path():
    assert dossier_label_from_path("notes/法律透镜报告.md") == "法律"
    assert dossier_label_from_path("notes/汇总与命题卡.md") == "汇总"


def test_extract_anchors_from_inline_and_footer():
    body = (
        "一审判赔 500 万#r1。\n\n"
        "## 来源台账锚\n\n"
        "- #r1 · https://court.example/a · 判决书\n"
        "- #r2 · https://news.example/b · 报道\n"
    )
    anchors = extract_research_ledger_anchors(body)
    assert [a.origin_id for a in anchors] == ["#r1", "#r2"]
    assert anchors[0].url == "https://court.example/a"
    assert anchors[0].title == "判决书"


def test_ensure_anchors_keeps_existing():
    body = "事实成立#r3。"
    out = ensure_research_file_anchors(
        body,
        [{"id": "#r1", "url": "https://x.example", "title": "X"}],
    )
    assert out == body


def test_ensure_anchors_appends_footer_when_missing():
    body = "无锚正文。"
    out = ensure_research_file_anchors(
        body,
        [
            {"id": "#r1", "url": "https://a.example", "title": "A"},
            {"id": "#r2", "url": "", "title": "B", "site": "b.example"},
        ],
    )
    assert "## 来源台账锚" in out
    assert "#r1 · https://a.example · A" in out
    assert "#r2" in out
    assert extract_research_ledger_anchors(out)


def test_ensure_anchors_skips_footer_when_unbound_bibliography():
    """Unbound GB/T [D] must not get a footer #rN dump (false comfort)."""
    body = "郝万鑫. 某问题研究[D]. 长江大学, 2026."
    out = ensure_research_file_anchors(
        body,
        [{"id": "#r1", "url": "https://a.example", "title": "A"}],
    )
    assert out == body
    assert "## 来源台账锚" not in out


def test_format_index_with_ledger_lines():
    text = format_research_dossier_index(
        ["notes/a.md"],
        ledger_lines=["- notes/a.md → #r1"],
    )
    assert "材料预登记台账" in text
    assert "#r1" in text
