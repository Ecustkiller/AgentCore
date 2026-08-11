"""计费归因头的传输契约（billing/attribution.py）。

``run_id`` / ``agent_id`` / ``persona`` 均可含自由文（委派任务名、CEO 自拟人设…），
几乎必然是非 ASCII——HTTP 头只能走 ASCII（httpx 直接抛 UnicodeEncodeError），所以
出站侧百分号编码、代理入站侧对称解码。本文件钉住这条往返链路：编码后的头必须能
构造真实 httpx 请求（即 ASCII 安全），解码后必须逐字还原；ASCII 旧值原样通过。
"""

from __future__ import annotations

import httpx

from agentcore.billing.attribution import (
    attribution_headers_from_context,
    parse_attribution_headers,
)
from agentcore.core.log_context import log_context
from agentcore.llm.credentials import (
    INFERENCE_AGENT_HEADER,
    INFERENCE_PARENT_RUN_HEADER,
    INFERENCE_PERSONA_HEADER,
    INFERENCE_RUN_HEADER,
)


def test_chinese_attribution_fields_roundtrip_through_http_headers():
    """非 ASCII run_id / agent_id / persona：出站编码 → 可上 HTTP 线 → 入站逐字还原。"""
    # Mirrors the 2026-08-11 bee6d53c outage: delegate task title spliced into run_id.
    run_id = "del_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_货盘提取"
    with log_context(
        run_id=run_id,
        parent_run_id="cap_主回合",
        agent_id="调研员-1",
        cost_role="member",
        persona="调研员",
    ):
        headers = attribution_headers_from_context()

    # The wire values must be ASCII — otherwise httpx refuses the request outright
    # (this was the crash: every Chinese-attributed sidecar LLM call died here).
    request = httpx.Request("POST", "http://proxy/v1/chat/completions", headers=headers)
    assert request.headers[INFERENCE_RUN_HEADER].isascii()
    assert request.headers[INFERENCE_PARENT_RUN_HEADER].isascii()
    assert request.headers[INFERENCE_AGENT_HEADER].isascii()
    assert request.headers[INFERENCE_PERSONA_HEADER].isascii()

    parsed = parse_attribution_headers(request.headers)
    assert parsed["run_id"] == run_id
    assert parsed["parent_run_id"] == "cap_主回合"
    assert parsed["agent_id"] == "调研员-1"
    assert parsed["persona"] == "调研员"
    assert parsed["role"] == "member"
    assert parsed["call_id"] is not None


def test_ascii_attribution_fields_pass_through_unchanged():
    """ASCII 值（CEO / 未编码旧客户端）编码是恒等变换，解码同样原样通过。"""
    with log_context(
        run_id="del_1",
        parent_run_id="cap_1",
        agent_id="CEO",
        cost_role="captain",
        persona="CEO",
    ):
        headers = attribution_headers_from_context()
    assert headers[INFERENCE_RUN_HEADER] == "del_1"
    assert headers[INFERENCE_PARENT_RUN_HEADER] == "cap_1"
    assert headers[INFERENCE_AGENT_HEADER] == "CEO"
    assert headers[INFERENCE_PERSONA_HEADER] == "CEO"
    parsed = parse_attribution_headers(headers)
    assert parsed["run_id"] == "del_1"
    assert parsed["parent_run_id"] == "cap_1"
    assert parsed["agent_id"] == "CEO"
    assert parsed["persona"] == "CEO"


def test_legacy_unencoded_ascii_headers_still_parse():
    """入站对未编码的旧 ASCII 值原样通过（与编码路径对称容错）。"""
    headers = {
        INFERENCE_RUN_HEADER: "del_1",
        INFERENCE_AGENT_HEADER: "CEO",
        INFERENCE_PERSONA_HEADER: "CEO",
    }
    parsed = parse_attribution_headers(headers)
    assert parsed["run_id"] == "del_1"
    assert parsed["agent_id"] == "CEO"
    assert parsed["persona"] == "CEO"


def test_absent_persona_stays_absent():
    with log_context(cost_role="captain"):
        headers = attribution_headers_from_context()
    assert INFERENCE_PERSONA_HEADER not in headers
    assert parse_attribution_headers(headers)["persona"] is None
