"""案 20260803-image-gen-byok-egress-boundary A+B — secret scrub + write gate."""

from __future__ import annotations

from agentcore.core.secrets import REDACTED, contains_secret, redact_secrets
from agentcore.tools.builtin.file_ops import format_artifact_manifest


def test_redact_secrets_masks_openai_style_key():
    assert redact_secrets("KEY=sk-abcdEFGH1234567890") == f"KEY={REDACTED}"


def test_contains_secret_detects_key_shape():
    assert contains_secret("sk-abcdEFGH1234567890") is True
    assert contains_secret("os.environ['OPENAI_API_KEY']") is False


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
