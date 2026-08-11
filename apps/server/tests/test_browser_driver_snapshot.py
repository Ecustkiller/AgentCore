"""Sandbox driver SNAPSHOT_JS — Local wire twin (placeholder/value/disabled/visible_text).

Host test env has no Playwright; jsdom (desktop node_modules) evals the same JS string
the in-sandbox Chromium runs. Parity: Local host SNAPSHOT_JS and this twin must produce
the same ``elements`` line shape for the same DOM (field names frozen).
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from agentcore.tools.sandbox.browser.driver import (
    _CLICK_PROBE_JS,
    _FOCUS_SELECT_JS,
    _READ_TYPED_JS,
    _SNAPSHOT_JS,
)
from agentcore.tools.sandbox.browser.protocol import ClickedReceipt, TypedReceipt

_REPO = Path(__file__).resolve().parents[3]
_DESKTOP = _REPO / "apps" / "desktop"

_JSDOM_RUNNER = r"""
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
// argv: [node, runner.js, snapshot.js, page.html, desktopRoot]
const snapshotJs = fs.readFileSync(process.argv[2], 'utf8');
const html = fs.readFileSync(process.argv[3], 'utf8');
const desktopRoot = process.argv[4];
const req = createRequire(path.join(desktopRoot, 'package.json'));
const { JSDOM } = req('jsdom');
const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://example.test/' });
const w = dom.window;
w.Element.prototype.getBoundingClientRect = function () {
  return {
    x: 0, y: 0, top: 0, left: 0, bottom: 24, right: 120,
    width: 120, height: 24, toJSON() { return {}; },
  };
};
const fnFactory = new w.Function(
  'document',
  'window',
  'NodeFilter',
  'return (' + snapshotJs + ')',
);
const fn = fnFactory(w.document, w, w.NodeFilter);
process.stdout.write(String(fn(1)));
"""


def _run_snapshot(html: str) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        js_path = Path(tmp) / "snapshot.js"
        html_path = Path(tmp) / "page.html"
        runner_path = Path(tmp) / "runner.js"
        js_path.write_text(_SNAPSHOT_JS, encoding="utf-8")
        html_path.write_text(html, encoding="utf-8")
        runner_path.write_text(_JSDOM_RUNNER, encoding="utf-8")
        proc = subprocess.run(
            [
                "node",
                str(runner_path),
                str(js_path),
                str(html_path),
                str(_DESKTOP),
            ],
            capture_output=True,
            text=True,
            check=False,
            env=os.environ.copy(),
        )
    if proc.returncode != 0:
        raise AssertionError(f"jsdom snapshot failed: {proc.stderr or proc.stdout}")
    return proc.stdout


@pytest.fixture(scope="module")
def jsdom_available() -> bool:
    try:
        r = subprocess.run(
            ["node", "-e", "require('jsdom')"],
            cwd=str(_DESKTOP),
            capture_output=True,
            text=True,
            check=False,
        )
        return r.returncode == 0
    except OSError:
        return False


def test_wire_receipt_typeddict_keys_frozen():
    """Field names must stay aligned with Local host (do not rename)."""
    typed: TypedReceipt = {
        "ref": "e1",
        "requested_chars": 3,
        "actual_chars": 3,
        "matched": True,
        "method": "cdp_insertText",
    }
    clicked: ClickedReceipt = {
        "ref": "e2",
        "was_disabled": True,
        "role": "button",
        "name": "Send",
    }
    assert set(typed) == {
        "ref",
        "requested_chars",
        "actual_chars",
        "matched",
        "method",
    }
    assert set(clicked) == {"ref", "was_disabled", "role", "name"}


def test_helper_js_twins_exist():
    assert "selectNodeContents" in _FOCUS_SELECT_JS
    assert "masked" in _READ_TYPED_JS and "password" in _READ_TYPED_JS
    assert "aria-disabled" in _CLICK_PROBE_JS and "was_disabled" in _CLICK_PROBE_JS
    assert "visible_text" in _SNAPSHOT_JS
    assert "placeholder=" in _SNAPSHOT_JS and "value=" in _SNAPSHOT_JS
    assert "contenteditable" in _SNAPSHOT_JS


def test_snapshot_placeholder_and_value_split(jsdom_available: bool):
    if not jsdom_available:
        pytest.skip("desktop jsdom not installed")
    out = _run_snapshot(
        """
        <!doctype html><html><body><main>
          <textarea aria-label="composer" placeholder="Type a message…">hello draft</textarea>
          <button disabled>Send</button>
        </main></body></html>
        """
    )
    assert "textarea: composer" in out
    assert 'placeholder="Type a message…"' in out
    assert 'value="hello draft"' in out
    assert "button disabled: Send" in out
    line = next(
        row for row in out.splitlines() if "textarea" in row and "composer" in row
    )
    assert "placeholder=" in line and "value=" in line


def test_snapshot_password_masked(jsdom_available: bool):
    if not jsdom_available:
        pytest.skip("desktop jsdom not installed")
    out = _run_snapshot(
        """
        <!doctype html><html><body>
          <input type="password" aria-label="pwd" value="hunter2" placeholder="Password" />
        </body></html>
        """
    )
    assert "password" in out
    assert "hunter2" not in out
    assert 'value="***"' in out
    assert "chars=7" in out


def test_snapshot_visible_text_tail(jsdom_available: bool):
    if not jsdom_available:
        pytest.skip("desktop jsdom not installed")
    out = _run_snapshot(
        """
        <!doctype html><html><body><main>
          <div class="bubble">Alice: first message</div>
          <div class="bubble">Bob: second message visible</div>
          <button>Reply</button>
        </main></body></html>
        """
    )
    assert "visible_text:" in out
    assert "Bob: second message visible" in out
    assert "---" in out


def test_snapshot_parity_shape_matches_local_fixture(jsdom_available: bool):
    """Same HTML fixture as Local browserSnapshotJs.test.ts → same structural markers.

    Guarantees Sandbox/Local ``elements`` wire shape stays aligned without Chromium.
    """
    if not jsdom_available:
        pytest.skip("desktop jsdom not installed")
    out = _run_snapshot(
        """
        <body>
          <main>
            <textarea
              aria-label="composer"
              placeholder="Type a message…"
            >hello draft</textarea>
            <button disabled>Send</button>
          </main>
        </body>
        """
    )
    assert any("textarea: composer" in row for row in out.splitlines())
    assert 'placeholder="Type a message…"' in out
    assert 'value="hello draft"' in out
    assert any("button disabled: Send" in row for row in out.splitlines())
    assert json.dumps({"elements": out}, ensure_ascii=False)
