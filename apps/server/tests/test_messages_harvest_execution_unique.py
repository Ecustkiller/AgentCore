"""Harvest unique-index migration: window predicate, guard, no data mutation."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agentcore.db.migrations.versions import (
    c8a1f3e6b2d9_messages_harvest_execution_unique as mig,
)
from agentcore.db.models.conversations import _HARVEST_USER_EXECUTION_WHERE


def test_index_predicate_uses_explicit_timestamptz_literal():
    assert mig._WHERE == _HARVEST_USER_EXECUTION_WHERE
    assert "TIMESTAMPTZ '2026-08-18 06:00:00+00'" in mig._WHERE
    assert "TIMESTAMP '" not in mig._WHERE.replace("TIMESTAMPTZ '", "")


def test_migration_source_does_not_mutate_rows():
    from pathlib import Path

    source = Path(mig.__file__).read_text(encoding="utf-8").lower()
    assert "delete from" not in source
    assert "update messages" not in source


def test_upgrade_raises_on_in_window_duplicates(monkeypatch):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [
        SimpleNamespace(execution_id="exec-dup", n=2)
    ]
    monkeypatch.setattr(mig.op, "get_bind", lambda: conn)
    create = MagicMock()
    monkeypatch.setattr(mig.op, "create_index", create)

    with pytest.raises(RuntimeError, match="index window"):
        mig.upgrade()
    create.assert_not_called()
    sql = str(conn.execute.call_args.args[0])
    assert "TIMESTAMPTZ '2026-08-18 06:00:00+00'" in sql


def test_upgrade_creates_index_when_window_is_clean(monkeypatch):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = []
    monkeypatch.setattr(mig.op, "get_bind", lambda: conn)
    create = MagicMock()
    monkeypatch.setattr(mig.op, "create_index", create)

    mig.upgrade()

    create.assert_called_once()
    kwargs = create.call_args.kwargs
    assert str(kwargs["postgresql_where"]) == mig._WHERE or mig._WHERE in str(
        kwargs["postgresql_where"]
    )


def test_downgrade_drops_with_the_same_predicate(monkeypatch):
    drop = MagicMock()
    monkeypatch.setattr(mig.op, "drop_index", drop)

    mig.downgrade()

    drop.assert_called_once()
    kwargs = drop.call_args.kwargs
    assert kwargs["table_name"] == "messages"
    assert mig._WHERE in str(kwargs["postgresql_where"])
