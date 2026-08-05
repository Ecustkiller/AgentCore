"""Unit tests for credential key-name preview (approval cards)."""

from __future__ import annotations

import pytest

from agentcore.runtime.credential_preview import (
    build_keys_preview_line,
    extract_env_key_names,
    format_keys_preview,
)

pytestmark = pytest.mark.anyio


def test_extract_dotenv_keys_skips_comments_and_values():
    text = """
# comment
DATABASE_URL=postgres://secret
export OPENAI_API_KEY=sk-secretvalue
EMPTY=
FOO=bar
FOO=dupe
not a key line
"""
    assert extract_env_key_names(text) == [
        "DATABASE_URL",
        "OPENAI_API_KEY",
        "EMPTY",
        "FOO",
    ]


def test_extract_json_object_keys():
    assert extract_env_key_names('{"api_key": "secret", "region": "us"}') == [
        "api_key",
        "region",
    ]
    assert extract_env_key_names("[1, 2]") == []


def test_format_keys_preview_empty():
    assert format_keys_preview([]) == ""
    line = format_keys_preview(["A", "B"])
    assert "键名预览（无值" in line
    assert "A, B" in line
    assert "sk-" not in line


async def test_build_keys_preview_line_from_backend():
    class _Backend:
        async def read(self, path: str) -> str:
            assert path == ".env"
            return "ALPHA=1\nBETA=two\n"

    line = await build_keys_preview_line(
        _Backend(), tool_name="file_read", arguments={"path": ".env"}
    )
    assert "ALPHA" in line and "BETA" in line
    assert "two" not in line
    assert "ALPHA=1" not in line


async def test_build_keys_preview_line_soft_fails():
    class _Backend:
        async def read(self, path: str) -> str:
            raise FileNotFoundError(path)

    assert (
        await build_keys_preview_line(
            _Backend(), tool_name="file_read", arguments={"path": ".env"}
        )
        == ""
    )
    assert (
        await build_keys_preview_line(
            object(), tool_name="file_read", arguments={"path": "README.md"}
        )
        == ""
    )


async def test_build_keys_preview_ignores_non_ask_paths():
    class _Backend:
        async def read(self, path: str) -> str:  # pragma: no cover
            raise AssertionError("must not read templates/deny paths for preview")

    assert (
        await build_keys_preview_line(
            _Backend(),
            tool_name="file_read",
            arguments={"path": ".env.example"},
        )
        == ""
    )
    assert (
        await build_keys_preview_line(
            _Backend(),
            tool_name="file_read",
            arguments={"path": "id_rsa"},
        )
        == ""
    )
    assert (
        await build_keys_preview_line(
            _Backend(),
            tool_name="code_search",
            arguments={"path": ".env"},
        )
        == ""
    )


async def test_preview_line_never_embeds_dotenv_values():
    """Key assertion: preview copy is keys-only (no values into circuit_breaker_hint)."""
    class _Backend:
        async def read(self, path: str) -> str:
            return "API_KEY=sk-live-should-never-leak\nREGION=us-east-1\n"

    line = await build_keys_preview_line(
        _Backend(), tool_name="file_read", arguments={"path": ".env"}
    )
    assert line.startswith("键名预览（无值")
    assert "API_KEY" in line and "REGION" in line
    assert "sk-live-should-never-leak" not in line
    assert "us-east-1" not in line
    assert "=" not in line.split("：", 1)[-1].split("（", 1)[0]
