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
