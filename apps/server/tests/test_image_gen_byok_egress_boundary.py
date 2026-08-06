"""案 20260803-image-gen-byok-egress-boundary A+B — secret scrub + write gate."""

from __future__ import annotations

from agentcore.core.secrets import REDACTED, contains_secret, redact_secrets
from agentcore.tools.builtin.file_ops import format_artifact_manifest


def test_redact_secrets_masks_openai_style_key():
    assert redact_secrets("KEY=sk-abcdEFGH1234567890") == f"KEY={REDACTED}"


def test_contains_secret_detects_key_shape():
    assert contains_secret("sk-abcdEFGH1234567890") is True
    assert contains_secret("OPENAI_API_KEY=sk-abcdEFGH1234567890") is True
    assert contains_secret("Authorization: Bearer abcDEF123456._-x") is True
    assert contains_secret("tvly-abcd1234efgh5678") is True
    assert contains_secret("gsk_abcd1234EFGH5678ijkl") is True
    assert contains_secret("xai-ABCDabcd12345678") is True
    assert contains_secret("AIzaSyA0bCdEfGhIjKlMnOpQr") is True
    assert contains_secret("ghp_abcdefghij0123456789ABCD") is True
    assert contains_secret("os.environ['OPENAI_API_KEY']") is False


def test_contains_secret_ignores_erp_field_names():
    """Word-boundary lookbehind: md/表字段名不得误命中 sk_/gsk_/… 形。"""
    for field in (
        "task_created_at",
        "task_priority",
        "risk_score_total",
        "ask_created_at",
        "| task_created_at | datetime |",
    ):
        assert contains_secret(field) is False, field


def test_artifact_manifest_end_preview_redacts_key():
    """案 B：写盘成功回执不得回显完整 Key（即使闸漏写仍脱敏）。"""
    body = "OPENAI_API_KEY=sk-abcdEFGH1234567890\nMODEL=imega2\n"
    out = format_artifact_manifest(
        path="env",
        content=body,
        bytes_written=len(body.encode()),
        kind="text",
    )
    assert "sk-abcdEFGH1234567890" not in out
    assert REDACTED in out
    assert "end_preview:" in out
