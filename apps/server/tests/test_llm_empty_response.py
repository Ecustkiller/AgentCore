"""Empty-response diagnosis helpers."""

import json

from agentcore.llm.errors import (
    EmptyResponseDiagnosis,
    diagnose_empty_response,
    empty_response_event_message,
)


def test_diagnose_content_filtered():
    body = json.dumps(
        {
            "choices": [{"message": {"content": ""}, "finish_reason": "content_filter"}],
        }
    )
    assert (
        diagnose_empty_response(raw_body=body, finish_reason="content_filter")
        is EmptyResponseDiagnosis.CONTENT_FILTERED
    )


def test_diagnose_oauth_html():
    body = "<html><body>Please sign in to continue</body></html>"
    assert (
        diagnose_empty_response(raw_body=body)
        is EmptyResponseDiagnosis.OAUTH_EXPIRED
    )


def test_diagnose_model_unknown():
    body = json.dumps({"error": {"message": "model not found: foo"}})
    assert (
        diagnose_empty_response(raw_body=body)
        is EmptyResponseDiagnosis.MODEL_UNKNOWN
    )


def test_diagnose_silent_empty():
    body = json.dumps(
        {
            "choices": [{"message": {"content": ""}, "finish_reason": "stop"}],
        }
    )
    assert (
        diagnose_empty_response(raw_body=body, finish_reason="stop")
        is EmptyResponseDiagnosis.SILENT_EMPTY
    )


def test_diagnose_format_mismatch():
    assert (
        diagnose_empty_response(raw_body="not-json {{{", format_mismatch=True)
        is EmptyResponseDiagnosis.FORMAT_MISMATCH
    )


def test_empty_response_event_message_appends_diagnosis():
    msg = empty_response_event_message(EmptyResponseDiagnosis.SILENT_EMPTY)
    assert msg.startswith("模型多次空响应")
    assert "模型返回空内容" in msg
