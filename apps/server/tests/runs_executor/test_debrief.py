"""完工交接简报 (debrief) parser — split a worker's product into deliverable + handoff.

The parser is best-effort and PURE: output that carries no parseable「## 交接简报」section
must round-trip to ``(content, None)`` so every read site behaves byte-identically to its
pre-debrief behaviour (load-bearing for conformance stability).
"""

from agentcore.runtime.runs.serialize import debrief_from_content, split_debrief


def test_parses_all_four_fields_and_peels_section_off_body():
    content = (
        "这是交付正文，第一段。\n第二段。\n\n"
        "## 交接简报\n"
        "- 结论：完成了登录接口重构\n"
        "- 关键要点：响应从 800ms 降到 120ms；改动 auth/login.py\n"
        "- 关键假设：沿用现有 JWT 方案\n"
        "- 建议下一步：给注册接口做同样的缓存改造\n"
    )
    body, debrief = split_debrief(content)
    assert body == "这是交付正文，第一段。\n第二段。"
    assert "交接简报" not in body  # section is peeled off the deliverable
    assert debrief is not None
    assert debrief["summary"] == "完成了登录接口重构"
    assert debrief["key_points"] == ["响应从 800ms 降到 120ms；改动 auth/login.py"]
    assert debrief["assumptions"] == "沿用现有 JWT 方案"
    assert debrief["next_steps"] == "给注册接口做同样的缓存改造"


def test_no_section_returns_content_unchanged():
    content = "纯交付正文，没有交接简报小节，结论就写在正文里。"
    body, debrief = split_debrief(content)
    assert body == content
    assert debrief is None


def test_mention_in_prose_without_heading_is_not_a_section():
    # The sentinel appears mid-prose but never as a heading → not a section.
    content = "我在正文里提到了交接简报这个词，但没有用它作小标题。"
    body, debrief = split_debrief(content)
    assert body == content
    assert debrief is None


def test_bold_heading_variant_and_no_bullets():
    content = "正文。\n\n**交接简报**\n结论：搞定了\n建议下一步：上线灰度"
    body, debrief = split_debrief(content)
    assert body == "正文。"
    assert debrief["summary"] == "搞定了"
    assert debrief["next_steps"] == "上线灰度"


def test_last_heading_wins_earlier_one_stays_in_body():
    content = (
        "## 交接简报\n结论：这是早期误用的小标题\n\n"
        "真正的交付内容在这里。\n\n"
        "## 交接简报\n结论：以最后这节为准\n"
    )
    body, debrief = split_debrief(content)
    assert debrief["summary"] == "以最后这节为准"
    assert "真正的交付内容在这里。" in body
    assert "早期误用" in body  # the earlier mis-heading remains part of the deliverable


def test_halfwidth_colon_is_tolerated():
    content = "正文\n\n## 交接简报\n结论: 半角冒号也能解析\n建议下一步: 同上"
    _, debrief = split_debrief(content)
    assert debrief["summary"] == "半角冒号也能解析"
    assert debrief["next_steps"] == "同上"


def test_multiline_value_appends_until_next_label():
    content = "正文\n\n## 交接简报\n结论：第一行结论\n继续补充的第二行\n建议下一步：下一步建议"
    _, debrief = split_debrief(content)
    assert debrief["summary"] == "第一行结论 继续补充的第二行"
    assert debrief["next_steps"] == "下一步建议"


def test_key_points_kept_as_a_list_of_bullets():
    content = "正文\n\n## 交接简报\n关键要点：\n- 要点一\n- 要点二\n- 要点三"
    _, debrief = split_debrief(content)
    assert debrief["key_points"] == ["要点一", "要点二", "要点三"]


def test_optional_fields_omitted_when_absent():
    content = "正文\n\n## 交接简报\n结论：只给了结论一条"
    _, debrief = split_debrief(content)
    assert debrief == {"summary": "只给了结论一条"}


def test_heading_without_recognizable_fields_degrades_to_none():
    content = "正文\n\n## 交接简报\n（这里啥结构都没有，只是一句散文）"
    body, debrief = split_debrief(content)
    assert debrief is None
    assert body == content  # nothing parseable → leave the content intact


def test_debrief_from_content_wrapper():
    assert debrief_from_content("正文\n\n## 交接简报\n结论：A") == {"summary": "A"}
    assert debrief_from_content("无简报") is None
    assert debrief_from_content("") is None
