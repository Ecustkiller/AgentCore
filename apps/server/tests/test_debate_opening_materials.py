"""开赛材料汇流：共享证据包、无 pack 对称有界预算。"""

from __future__ import annotations

from unittest.mock import MagicMock

from agentcore.runtime.debate.evidence_ledger import (
    EvidenceLedger,
)
from agentcore.runtime.debate.evidence_pack import (
    apply_opening_materials,
    assemble_evidence_pack_from_host,
    parse_attached_file_sources,
)
from agentcore.runtime.debate.types import (
    DebateConfig,
    DebateForm,
    DebateSide,
    RoundPolicy,
)


def _config() -> DebateConfig:
    return DebateConfig(
        motion="是否采用方案 A",
        form=DebateForm.DEBATE,
        sides=[
            DebateSide(key="pro", name="支持方", stance="支持采用方案 A"),
            DebateSide(key="con", name="反对方", stance="反对采用方案 A"),
        ],
        policy=RoundPolicy(max_rounds=5),
    )


_ATTACHED_TEXT_PROMPT = """
系统前缀…
<附件>
The user attached the following files as actionable inputs.

--- File: 合同.md (attachments/合同.md) ---
第一条 甲方应在签署后 30 日内支付首期款项。
第二条 争议提交仲裁委员会。
</附件>
"""

_ATTACHED_BINARY_ONLY_PROMPT = """
<附件>
--- File: report.xlsx (attachments/report.xlsx) [binary] ---
This is a binary file saved in the workspace (no text inline).
CEO has no code_execute — delegate a worker to open/parse it with code_execute
on the workspace-relative path above.
</附件>
"""


def test_evidence_ledger_continues_turn_ids():
    """开辩包当轮核：已有 #r1 续到 #r2，同 URL 去重回既有 id。"""
    from agentcore.runtime.evidence_ledger import EvidenceLedgerCore

    core = EvidenceLedgerCore(id_prefix="#r")
    assert (
        core.register_sync(
            url="https://a.example", title="A", registrant="ceo"
        )
        == "#r1"
    )
    led = EvidenceLedger(core=core)
    assert led.get("#r1")["url"] == "https://a.example"
    assert "#r1" in led.ids
    assert [e["id"] for e in led.drain_delta()] == ["#r1"]
    assert led.drain_delta() == []
    assert (
        led.register(url="https://b.example", title="B", side_key="pro") == "#r2"
    )
    assert led.register(url="https://a.example", title="A2", side_key="con") == "#r1"


def test_opening_materials_no_pack_symmetric_bounded_budgets():
    """无可用 pack → completeness=empty；各方对称有界发言期预算。"""
    from agentcore.runtime.debate.constants import BOUNDED_GAP_FILL_RETRIEVAL_BUDGET

    tool = MagicMock()
    tool._evidence_ledger = EvidenceLedger()
    cfg = _config()
    result = apply_opening_materials(
        system_prompt="",
        config=cfg,
        ledger=tool._evidence_ledger,
    )
    assert result.path == "no_pack"
    assert result.completeness == "empty"
    assert result.evidence_ready is False
    assert cfg.debater_retrieval_budgets == {
        "pro": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
        "con": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
    }
    assert BOUNDED_GAP_FILL_RETRIEVAL_BUDGET > 0
    assert "材料不完整" in (cfg.research_dossier_index or "")
    assert cfg.evidence_completeness == "empty"


def test_parse_attached_file_sources_text_and_binary():
    text_srcs = parse_attached_file_sources(_ATTACHED_TEXT_PROMPT)
    assert len(text_srcs) == 1
    assert text_srcs[0].label == "合同.md"
    assert "第一条" in text_srcs[0].excerpt

    bin_srcs = parse_attached_file_sources(_ATTACHED_BINARY_ONLY_PROMPT)
    assert len(bin_srcs) == 1
    assert bin_srcs[0].failure == "binary_no_text"
    assert bin_srcs[0].excerpt == ""


def test_assemble_evidence_pack_from_host_full():
    pack = assemble_evidence_pack_from_host(
        system_prompt=_ATTACHED_TEXT_PROMPT,
        motion="是否采用方案 A",
        sides=_config().sides,
        background="背景补充一句。",
    )
    assert pack is not None
    assert pack.has_usable_body()
    assert pack.completeness in ("full", "partial")
    assert any(s.kind == "background" for s in pack.sources)
    assert len(pack.dispute_candidates) == 2
    wire = pack.to_wire()
    assert wire["sources"]
    assert wire["dispute_candidates"]


def test_opening_materials_with_attachments():
    """附件已在主持人上下文 → 共享证据包；立论外搜预算 0。"""
    tool = MagicMock()
    tool._evidence_ledger = EvidenceLedger()
    cfg = _config()
    result = apply_opening_materials(
        system_prompt=_ATTACHED_TEXT_PROMPT,
        config=cfg,
        ledger=tool._evidence_ledger,
    )
    assert result.path == "evidence_pack"
    assert result.evidence_ready is True
    assert result.completeness == "full"
    assert cfg.evidence_pack is not None
    assert cfg.evidence_pack.has_usable_body()
    assert cfg.evidence_completeness == "full"
    assert cfg.debater_retrieval_budgets == {"pro": 0, "con": 0}
    assert "共享证据包" in (cfg.research_dossier_index or "")
    assert "完整度=" in (cfg.research_dossier_index or "")
    assert len(tool._evidence_ledger) >= 1


def test_assemble_evidence_pack_truncated_is_partial():
    """截断附件 → pack.completeness=partial，索引带不完整标注。"""
    from agentcore.runtime.debate.evidence_pack import format_evidence_pack_index

    long_body = "条款正文。" * 400
    prompt = f"""
<附件>
--- File: 长约.md (attachments/长约.md) [truncated] ---
{long_body}
</附件>
"""
    pack = assemble_evidence_pack_from_host(
        system_prompt=prompt,
        motion="是否采用方案 A",
        sides=_config().sides,
    )
    assert pack is not None
    assert pack.completeness == "partial"
    assert any(s.failure == "truncated" for s in pack.sources)
    index = format_evidence_pack_index(pack)
    assert "完整度=partial" in index
    assert "材料不完整" in index


def test_opening_materials_binary_attachments_no_pack():
    """仅 binary 附件（无可用正文）→ no_pack + 有界预算。"""
    from agentcore.runtime.debate.constants import BOUNDED_GAP_FILL_RETRIEVAL_BUDGET

    tool = MagicMock()
    tool._evidence_ledger = EvidenceLedger()
    cfg = _config()
    result = apply_opening_materials(
        system_prompt=_ATTACHED_BINARY_ONLY_PROMPT,
        config=cfg,
        ledger=tool._evidence_ledger,
    )
    assert result.path == "no_pack"
    assert result.completeness == "empty"
    assert cfg.debater_retrieval_budgets == {
        "pro": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
        "con": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
    }


def test_resolve_external_evidence_plan_always_skips():
    """完整度驱动：任意路径均 skip 外证；发言期预算另算。"""
    from agentcore.runtime.debate.constants import BOUNDED_GAP_FILL_RETRIEVAL_BUDGET
    from agentcore.runtime.debate.evidence_pack import (
        debater_budgets_from_completeness,
        resolve_external_evidence_plan,
    )

    full = resolve_external_evidence_plan(
        completeness="full",
        path="evidence_pack",
    )
    assert full.mode == "skip"
    assert full.allow_external is False
    assert full.retrieval_budget == 0
    assert full.reason == "evidence_pack_full"

    partial = resolve_external_evidence_plan(
        completeness="partial",
        path="evidence_pack",
    )
    assert partial.mode == "skip"
    assert partial.allow_external is False
    assert partial.reason == "evidence_pack_partial"

    no_pack = resolve_external_evidence_plan(
        completeness="empty",
        path="no_pack",
    )
    assert no_pack.mode == "skip"
    assert no_pack.reason == "no_pack"

    budgets = debater_budgets_from_completeness(
        side_keys=["pro", "con"],
        completeness="partial",
    )
    assert budgets == {
        "pro": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
        "con": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
    }
    full_budgets = debater_budgets_from_completeness(
        side_keys=["pro", "con"],
        completeness="full",
    )
    assert full_budgets == {"pro": 0, "con": 0}


def test_opening_materials_partial_pack_bounded_budgets():
    """截断附件 → partial pack；各方对称有界发言期预算。"""
    from agentcore.runtime.debate.constants import BOUNDED_GAP_FILL_RETRIEVAL_BUDGET

    long_body = "条款正文。" * 400
    prompt = f"""
<附件>
--- File: 长约.md (attachments/长约.md) [truncated] ---
{long_body}
</附件>
"""
    tool = MagicMock()
    tool._evidence_ledger = EvidenceLedger()
    cfg = _config()
    result = apply_opening_materials(
        system_prompt=prompt,
        config=cfg,
        ledger=tool._evidence_ledger,
    )
    assert result.path == "evidence_pack"
    assert result.evidence_ready is True
    assert result.completeness == "partial"
    assert cfg.debater_retrieval_budgets == {
        "pro": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
        "con": BOUNDED_GAP_FILL_RETRIEVAL_BUDGET,
    }
    assert BOUNDED_GAP_FILL_RETRIEVAL_BUDGET > 0
    assert "材料不完整" in (cfg.research_dossier_index or "")
