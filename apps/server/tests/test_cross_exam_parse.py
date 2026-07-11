"""质询作答解析单测（JSON 主路径 + 启发式降级）。"""

import json

from agentcore.runtime.debate.cross_exam_parse import (
    build_cross_exam_exchanges,
    parse_cross_exam_response,
)


def test_parse_cross_exam_response_json_array():
    qs = [
        "收益量化口径是否计入了尾部风险？请是/否直接回答。",
        "若熔断触发、灰度止损，已投入成本由谁承担？",
    ]
    payload = [
        {
            "question_index": 1,
            "answer": "否，量化口径未含尾部风险【待核实·推断】。",
            "directly_addressed": True,
        },
        {
            "question_index": 2,
            "answer": "成本由灰度预算池兜底、触发熔断即回滚【已核实·灰度预案v2】",
            "directly_addressed": True,
        },
    ]
    got = parse_cross_exam_response(qs, json.dumps(payload, ensure_ascii=False))
    assert len(got) == 2
    assert got[0].question == qs[0]
    assert "尾部" in got[0].answer
    assert got[0].ok is True
    assert got[1].question == qs[1]
    assert "灰度" in got[1].answer
    assert got[1].ok is True


def test_parse_cross_exam_response_json_in_fence():
    qs = ["你这条有出处吗？"]
    raw = (
        "说明：以下是我的回答\n```json\n"
        + json.dumps(
            [{"question_index": 1, "answer": "暂无统一出处【待核实·推断】", "directly_addressed": False}],
            ensure_ascii=False,
        )
        + "\n```"
    )
    got = parse_cross_exam_response(qs, raw)
    assert len(got) == 1
    assert got[0].ok is False
    assert "出处" in got[0].answer


def test_parse_cross_exam_response_missing_item_marks_not_ok():
    qs = ["Q1", "Q2"]
    payload = [{"question_index": 1, "answer": "只答了第一条", "directly_addressed": True}]
    got = parse_cross_exam_response(qs, json.dumps(payload))
    assert got[0].ok is True
    assert got[1].answer == ""
    assert got[1].ok is False


def test_parse_cross_exam_response_scalar_string_array():
    """辩手少包一层 wrapper：``["答一","答二"]`` 按位置映射，不静默丢答。"""
    qs = ["收益是否计入尾部风险？", "熔断成本由谁承担？"]
    payload = [
        "否，量化口径未含尾部风险【待核实·推断】。",
        "成本由灰度预算池兜底【已核实·灰度预案v2】",
    ]
    got = parse_cross_exam_response(qs, json.dumps(payload, ensure_ascii=False))
    assert len(got) == 2
    assert "尾部" in got[0].answer
    assert got[0].ok is True
    assert "灰度" in got[1].answer
    assert got[1].ok is True


def test_parse_cross_exam_response_scalar_array_in_prose():
    """prose 中夹可解析标量数组时走 JSON 路径并按位置映射。"""
    qs = ["Q1", "Q2"]
    raw = '作答如下：\n["答一内容", "答二内容"]\n以上。'
    got = parse_cross_exam_response(qs, raw)
    assert got[0].answer == "答一内容"
    assert got[0].ok is True
    assert got[1].answer == "答二内容"
    assert got[1].ok is True


def test_parse_cross_exam_response_falls_back_to_heuristic():
    qs = ["收益是否计入尾部风险？"]
    ans = "作答：否，口径未含尾部【待核实·推断】。"
    got = parse_cross_exam_response(qs, ans)
    assert len(got) == 1
    assert "尾部" in got[0].answer
    assert got[0].ok is True


def test_build_cross_exam_exchanges_single_question():
    qs = ["收益是否计入尾部风险？"]
    ans = "作答：否，口径未含尾部【待核实·推断】。"
    got = build_cross_exam_exchanges(qs, ans)
    assert len(got) == 1
    assert got[0].question == qs[0]
    assert "尾部" in got[0].answer
    assert got[0].ok is True


def test_build_cross_exam_exchanges_splits_by_semicolon():
    qs = [
        "收益量化口径是否计入了尾部风险？请是/否直接回答。",
        "若熔断触发、灰度止损，已投入成本由谁承担？",
    ]
    ans = (
        "量化口径未含尾部风险【待核实·推断】；"
        "成本由灰度预算池兜底、触发熔断即回滚【已核实·灰度预案v2】"
    )
    got = build_cross_exam_exchanges(qs, ans)
    assert len(got) == 2
    assert got[0].ok and got[1].ok
    assert "尾部" in got[0].answer
    assert "灰度" in got[1].answer


def test_build_cross_exam_exchanges_empty_answer_marks_not_ok():
    got = build_cross_exam_exchanges(["Q1", "Q2"], "", overall_ok=False)
    assert len(got) == 2
    assert all(not ex.ok for ex in got)


def test_parse_json_path_respects_overall_ok():
    """JSON 主路径纳入 overall_ok：有答文时 overall_ok=False → ok 全 False。"""
    qs = ["Q1", "Q2"]
    payload = [
        {"question_index": 1, "answer": "答一", "directly_addressed": True},
        {"question_index": 2, "answer": "答二", "directly_addressed": True},
    ]
    got = parse_cross_exam_response(
        qs, json.dumps(payload, ensure_ascii=False), overall_ok=False
    )
    assert all(ex.answer for ex in got)
    assert all(not ex.ok for ex in got)


def test_section_split_ignores_decimal_like_line_starts():
    """行首「3.5 倍…」不得被数字分段误切为第 3 段；真「1. / 2.」标题仍切。"""
    qs = ["Q1", "Q2"]
    ans = (
        "1. 第一答：口径未含尾部【待核实·推断】。\n"
        "2. 第二答：成本由灰度预算池兜底；其中 3.5 倍杠杆不改变结论【已核实·预案】。"
    )
    got = build_cross_exam_exchanges(qs, ans)
    assert len(got) == 2
    assert "尾部" in got[0].answer
    assert "灰度" in got[1].answer
    assert "3.5" in got[1].answer
    assert got[0].ok and got[1].ok


def test_section_split_does_not_treat_lone_decimal_as_section_marker():
    """全文以小数开头且无第二段标题时，不误切（回落全文挂第一条）。"""
    qs = ["Q1", "Q2"]
    ans = "3.5 倍杠杆下尾部风险被低估【待核实·推断】；另一点是熔断成本归属未定。"
    got = build_cross_exam_exchanges(qs, ans)
    assert len(got) == 2
    # 无合法「1. / 2.」标题 → 分号切或全文挂首条，不应把「3.5」当第 3 段丢内容
    assert any("3.5" in ex.answer for ex in got)
