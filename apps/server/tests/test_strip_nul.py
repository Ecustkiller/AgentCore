"""Unit tests for repository-layer NUL stripping (Postgres text/JSONB)."""

from agentcore.db.repositories._base import strip_nul
from agentcore.workspace.write_claims import OWNERSHIP_KEY_SEP, make_ownership_key


def test_strip_nul_removes_null_bytes_from_str():
    assert strip_nul("a\x00b\x00c") == "abc"
    assert strip_nul("clean") == "clean"
    assert strip_nul("") == ""


def test_strip_nul_recurses_dict_list():
    payload = {
        "result": "ok\x00",
        "nested": {"stdout": "line\x00line"},
        "items": ["a\x00", {"x": "\x00y"}],
    }
    assert strip_nul(payload) == {
        "result": "ok",
        "nested": {"stdout": "lineline"},
        "items": ["a", {"x": "y"}],
    }


def test_strip_nul_cleans_dict_keys():
    """JSONB object keys are text — NUL in keys must be stripped too."""
    dirty = {"desk\x00src/a.ts": "run-1", "nested": {"k\x00ey": "v\x00"}}
    assert strip_nul(dirty) == {"desksrc/a.ts": "run-1", "nested": {"key": "v"}}


def test_strip_nul_coordination_snapshot_with_legacy_nul_keys():
    """Historical ownership keys used ``\\x00``; journal append must sanitize."""
    legacy_key = "desk-a\x00App.tsx"
    payload = {
        "snapshot": {
            "file_ownership": {
                "_v": 3,
                "owners": {legacy_key: "fe_a"},
                "written": [legacy_key],
            }
        }
    }
    clean = strip_nul(payload)
    owners = clean["snapshot"]["file_ownership"]["owners"]
    written = clean["snapshot"]["file_ownership"]["written"]
    assert "\x00" not in str(clean)
    assert owners == {"desk-aApp.tsx": "fe_a"}
    assert written == ["desk-aApp.tsx"]


def test_ownership_key_sep_is_postgres_safe():
    """Live ledger keys must not reintroduce NUL into journalable snapshots."""
    assert "\x00" not in OWNERSHIP_KEY_SEP
    key = make_ownership_key("desk-a", "src/App.tsx")
    assert OWNERSHIP_KEY_SEP in key
    assert "\x00" not in key
    # Defense in depth: strip_nul is a no-op for current keys.
    snap = {"owners": {key: "r1"}, "written": [key]}
    assert strip_nul(snap) == snap


def test_strip_nul_preserves_non_strings():
    assert strip_nul(None) is None
    assert strip_nul(42) == 42
    assert strip_nul(True) is True
    assert strip_nul(b"\x00") == b"\x00"  # bytes columns are not text/jsonb strings
