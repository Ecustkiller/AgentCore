"""The integration suite's no-database posture must stay environment-dependent.

Pinned as a *unit* test — i.e. inside the `--ignore=tests/integration` slice that
`release:gate` and every CI job actually run — because the failure mode is invisible
from the outside: when `tests/integration` skips itself away on a runner without
PostgreSQL, 58 files of DB-backed contracts stop being checked and the suite still
reports green. Nothing else would catch a regression back to unconditional skip.
"""

import pytest

from tests.integration.conftest import _integration_db_required, _no_postgres


@pytest.mark.parametrize(
    ("ci", "override", "required"),
    [
        # Dev box: skipping keeps unit-only work unblocked.
        (None, None, False),
        # GitHub Actions and every other mainstream runner export CI.
        ("true", None, True),
        ("1", None, True),
        # Exported-but-empty / explicitly false is not a CI.
        ("", None, False),
        ("false", None, False),
        # Override wins both ways: unit-only CI job / DB-demanding dev box.
        ("true", "0", False),
        (None, "1", True),
    ],
)
def test_db_required_follows_environment(
    monkeypatch: pytest.MonkeyPatch,
    ci: str | None,
    override: str | None,
    required: bool,
) -> None:
    for name, value in (("CI", ci), ("REQUIRE_INTEGRATION_DB", override)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)

    assert _integration_db_required() is required


def test_unreachable_db_fails_loudly_on_ci(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CI", "true")
    monkeypatch.delenv("REQUIRE_INTEGRATION_DB", raising=False)

    with pytest.raises(pytest.fail.Exception) as excinfo:
        _no_postgres(OSError("connection refused"))

    # The message must name the escape hatch, or the next red CI just re-adds a skip.
    assert "REQUIRE_INTEGRATION_DB=0" in str(excinfo.value)


def test_unreachable_db_skips_on_a_dev_box(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("REQUIRE_INTEGRATION_DB", raising=False)

    with pytest.raises(pytest.skip.Exception):
        _no_postgres(OSError("connection refused"))
