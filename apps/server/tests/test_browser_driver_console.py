"""Sandbox driver console ring-buffer contract (no Playwright / no Chromium).

Exercises scrubbing, hard caps, and ``Driver.console`` reply shape via Fake page hooks.
"""

from __future__ import annotations

import pytest

from agentcore.tools.sandbox.browser import driver as drv


class _FakeConsoleMsg:
    def __init__(self, type_: str, text: str) -> None:
        self.type = type_
        self.text = text


class _FakePageError(Exception):
    def __init__(self, message: str, stack: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.stack = stack


class _FakePage:
    def __init__(self) -> None:
        self.url = "https://example.com/blank"
        self._handlers: dict[str, object] = {}

    def on(self, event: str, handler) -> None:
        self._handlers[event] = handler

    async def title(self) -> str:
        return "Blank"


def _driver_with_fake_page() -> drv.Driver:
    d = drv.Driver()
    page = _FakePage()
    d._page = page
    page.on("console", d._on_page_console)
    page.on("pageerror", d._on_page_error)
    return d


def test_scrub_redacts_password_and_truncates_blob():
    assert "=[redacted]" in drv._scrub_console_text("password=hunter2 ok")
    blob = "A" * 5000
    out = drv._scrub_console_text(blob)
    assert out.endswith("…[truncated blob]")
    assert len(out) < 120


def test_console_ring_drops_oldest_and_reports_truncated():
    d = _driver_with_fake_page()
    for i in range(drv._CONSOLE_MAX_MESSAGES + 5):
        d._on_page_console(_FakeConsoleMsg("log", f"line-{i}"))
    assert len(d._console_messages) == drv._CONSOLE_MAX_MESSAGES
    assert d._console_messages_dropped == 5
    assert d._console_messages[0]["text"] == "line-5"
    assert d._console_messages[-1]["text"] == f"line-{drv._CONSOLE_MAX_MESSAGES + 4}"


@pytest.mark.asyncio
async def test_console_command_returns_messages_and_errors():
    d = _driver_with_fake_page()
    d._on_page_console(_FakeConsoleMsg("error", "boom"))
    d._on_page_error(_FakePageError("uncaught", "Error: uncaught\n    at x.js:1"))
    res = await d.console({})
    assert res["final_url"] == "https://example.com/blank"
    assert res["title"] == "Blank"
    assert res["messages"][0]["level"] == "error"
    assert res["messages"][0]["text"] == "boom"
    assert "timestamp" in res["messages"][0]
    assert res["errors"][0]["message"] == "uncaught"
    assert res["errors"][0]["stack"].startswith("Error: uncaught")
    assert res["truncated"] == {"messages_dropped": 0, "errors_dropped": 0}


def test_console_in_commands_allowlist():
    assert "console" in drv._COMMANDS
