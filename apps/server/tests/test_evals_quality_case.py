"""合成 eval 用例反向指回质量案（``quality_case``）：解析可读 + 缺省空列表.

lint 三种情况（合法数组 / 格式非法 / 缺省不填）在 ``test_evals_seed_lint.py``。
本文件只证 ``_parse_case`` 真读到该字段，且 ``_note`` 仍被静默丢弃。
"""

from __future__ import annotations

from agentcore.evals.runner import _parse_case


def test_parse_case_reads_quality_case_array() -> None:
    case = _parse_case(
        {
            "id": "c",
            "category": "qa",
            "user_message": "u",
            "quality_case": [
                "qc-20260817-delegate-skipped-on-multifile-edit",
                "qc-20260818-empty-delivery",
            ],
            "_note": "must be dropped",
        }
    )
    assert case.quality_case == [
        "qc-20260817-delegate-skipped-on-multifile-edit",
        "qc-20260818-empty-delivery",
    ]
    assert not hasattr(case, "_note")


def test_parse_case_defaults_quality_case_to_empty() -> None:
    case = _parse_case({"id": "c", "category": "qa", "user_message": "u"})
    assert case.quality_case == []
