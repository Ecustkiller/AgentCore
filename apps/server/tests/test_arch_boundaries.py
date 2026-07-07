"""Architecture import-boundary guards (executable layering contract).

Encodes the dependency contracts from ``docs/02-架构/项目结构.md`` §二 as tests so
the refined boundaries can't silently erode again. Each test parses real source
files (via ``ast``) and asserts the absence of forbidden ``agentcore.*`` imports.

The contracts are deliberately *pragmatic*, not maximal (post-2026-06 META
review): they forbid the couplings that genuinely break layering — routes
*executing*, the LLM gateway reaching into the DB, ``core`` depending upward —
while allowing the documented benign ones (routes reusing pricing constants /
runtime DTOs / credential resolution; ``core`` depending on ``config``). When a
boundary legitimately needs to change, update *both* this test and the doc — that
paired edit is the point.
"""

from __future__ import annotations

import ast
from collections.abc import Iterable
from pathlib import Path

_SERVER_ROOT = Path(__file__).resolve().parents[1]
_PKG_ROOT = _SERVER_ROOT / "agentcore"


def _module_imports(path: Path) -> set[str]:
    """All ``agentcore.*`` dotted module targets imported by a source file.

    ``from agentcore.llm.factory import build_provider`` -> ``agentcore.llm.factory``;
    ``import agentcore.db.x`` -> ``agentcore.db.x``. Relative imports are ignored
    (they can't cross top-level package boundaries).
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module and node.module.startswith("agentcore"):
                out.add(node.module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("agentcore"):
                    out.add(alias.name)
    return out


def _py_files(*rel: str) -> list[Path]:
    """Resolve package-relative paths to ``.py`` files (file or recursive dir)."""
    files: list[Path] = []
    for r in rel:
        base = _PKG_ROOT / r
        if base.is_file():
            files.append(base)
        else:
            files.extend(p for p in base.rglob("*.py") if "__pycache__" not in p.parts)
    return files


def _violations(files: Iterable[Path], forbidden: Iterable[str]) -> dict[str, set[str]]:
    """Map ``relpath -> forbidden imports found``; empty dict == contract holds."""
    forbidden = tuple(forbidden)
    bad: dict[str, set[str]] = {}
    for f in files:
        hits = {
            imp
            for imp in _module_imports(f)
            for pref in forbidden
            if imp == pref or imp.startswith(pref + ".")
        }
        if hits:
            bad[str(f.relative_to(_PKG_ROOT))] = hits
    return bad


def test_api_routes_do_not_execute() -> None:
    """HTTP routes delegate; they never build LLM providers nor drive the pipeline.

    Routes legitimately import runtime DTOs/helpers, pricing constants and
    credential resolution (documented benign). But constructing a provider
    (``llm.factory``) or running the engine (``runtime.pipeline`` /
    ``runtime.engine``) belongs in the service/runtime layer — e.g. ``files.py``
    delegates rewriting to ``assist.rewrite`` instead of building a provider
    inline.
    """
    forbidden = (
        "agentcore.llm.factory",
        "agentcore.runtime.pipeline",
        "agentcore.runtime.engine",
    )
    files = [f for f in _py_files("api/routes") if "inference" not in f.parts]
    assert _violations(files, forbidden) == {}


def test_llm_gateway_does_not_import_db() -> None:
    """The LLM gateway is a pure outbound adapter — no DB/business coupling.

    The only exemptions are the credential bridge (``byok`` / ``key_service``),
    which intentionally read user-scoped keys from the DB to resolve BYOK creds.
    """
    bridge = {"byok.py", "key_service.py", "resolve.py"}
    files = [f for f in _py_files("llm") if f.name not in bridge]
    assert _violations(files, ("agentcore.db",)) == {}


def test_core_has_no_upward_business_deps() -> None:
    """``core`` is the bottom layer: shared infra/types, zero business imports.

    It may depend on ``config`` (settings/logging/net wiring) but nothing above
    it — so ``core.net`` can host the shared SSRF/timeout primitives consumed by
    both the web tools and the favicon route without an ``api -> tools`` edge.
    """
    forbidden = (
        "agentcore.api",
        "agentcore.runtime",
        "agentcore.tools",
        "agentcore.llm",
        "agentcore.db",
        "agentcore.conversation",
        "agentcore.memory",
        "agentcore.board",
        "agentcore.evals",
        "agentcore.assist",
        "agentcore.vision",
        "agentcore.sidecar",
        "agentcore.conformance",
        "agentcore.workspace",
    )
    exempt = {"errors.py"}  # lazy-imports llm.errors for SSE error context projection
    files = [f for f in _py_files("core") if f.name not in exempt]
    assert _violations(files, forbidden) == {}


def test_leaf_web_tools_do_not_import_runtime_or_llm() -> None:
    """Leaf tools are self-contained — no reach into runtime/llm.

    (Orchestration primitives such as delegate/debate legitimately drive the
    runtime, so only the leaf web tools are asserted here.)
    """
    files = _py_files("tools/builtin/web")
    assert _violations(files, ("agentcore.runtime", "agentcore.llm")) == {}
