"""Zip extract ceilings: actual uncompressed bytes, not only ZIP metadata ``file_size``."""

from __future__ import annotations

import io
import zipfile
from typing import Any

import pytest

from agentcore.storage._archive import ZipExtractLimitError, iter_zip_file_members


def _zip_bytes(mapping: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        for name, data in mapping.items():
            zf.writestr(name, data)
    return buf.getvalue()


class _FullBodyReader:
    """Context-managed reader that returns the full body (ignores ZipInfo.file_size)."""

    def __init__(self, blob: bytes) -> None:
        self._buf = io.BytesIO(blob)

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self) -> _FullBodyReader:
        return self

    def __exit__(self, *args: object) -> None:
        return None


def _patch_underreported_member(
    monkeypatch: pytest.MonkeyPatch,
    *,
    payload_by_name: dict[str, bytes],
    claimed_size: int,
) -> None:
    """Make metadata claim ``claimed_size`` while ``open`` yields the full payload.

    CPython's ZipExtFile truncates to ``file_size`` (and CRC-checks that slice), so a
    real under-report cannot inflate past the header. We still gate on *actual*
    bytes after read — this patch simulates a hostile/other reader that returns
    the true body while headers under-report.
    """
    real_infolist = zipfile.ZipFile.infolist

    def infolist(self: zipfile.ZipFile) -> list[Any]:
        infos = real_infolist(self)
        for info in infos:
            info.file_size = claimed_size
        return infos

    def patched_open(
        self: zipfile.ZipFile, name: Any, *args: object, **kwargs: object
    ) -> _FullBodyReader:
        info = name if hasattr(name, "filename") else None
        filename = info.filename if info is not None else str(name)
        return _FullBodyReader(payload_by_name[filename])

    monkeypatch.setattr(zipfile.ZipFile, "infolist", infolist)
    monkeypatch.setattr(zipfile.ZipFile, "open", patched_open)


def test_iter_zip_rejects_when_declared_size_exceeds_limit():
    data = _zip_bytes({"a.bin": b"x" * 50})
    with pytest.raises(ZipExtractLimitError) as ei:
        iter_zip_file_members(data, max_uncompressed_bytes=40)
    assert ei.value.reason == "max_uncompressed_bytes"


def test_iter_zip_rejects_lied_small_file_size(monkeypatch: pytest.MonkeyPatch):
    """Under-reported ``file_size`` must not bypass the actual-byte ceiling."""
    payload = b"Z" * 200
    data = _zip_bytes({"bomb.bin": payload})
    _patch_underreported_member(
        monkeypatch,
        payload_by_name={"bomb.bin": payload},
        claimed_size=10,
    )

    with pytest.raises(ZipExtractLimitError) as ei:
        iter_zip_file_members(data, max_uncompressed_bytes=100)
    assert ei.value.reason == "max_uncompressed_bytes"
    assert ei.value.total_bytes == 0


def test_iter_zip_accumulates_actual_bytes_across_members(monkeypatch: pytest.MonkeyPatch):
    """First member honest; second under-reports — actual sum must still enforce."""
    a_payload = b"a" * 60
    b_payload = b"b" * 60
    data = _zip_bytes({"a.bin": a_payload, "b.bin": b_payload})

    real_infolist = zipfile.ZipFile.infolist

    def infolist(self: zipfile.ZipFile) -> list[Any]:
        infos = real_infolist(self)
        for info in infos:
            if info.filename == "b.bin":
                info.file_size = 10  # lie: declared total 70 ≤ 100
        return infos

    def patched_open(
        self: zipfile.ZipFile, name: Any, *args: object, **kwargs: object
    ) -> _FullBodyReader:
        info = name if hasattr(name, "filename") else None
        filename = info.filename if info is not None else str(name)
        blob = a_payload if filename == "a.bin" else b_payload
        return _FullBodyReader(blob)

    monkeypatch.setattr(zipfile.ZipFile, "infolist", infolist)
    monkeypatch.setattr(zipfile.ZipFile, "open", patched_open)

    with pytest.raises(ZipExtractLimitError) as ei:
        iter_zip_file_members(data, max_uncompressed_bytes=100)
    assert ei.value.reason == "max_uncompressed_bytes"
    assert ei.value.total_bytes == 60
    assert ei.value.file_count == 1


def test_iter_zip_allows_under_limit_actual_bytes():
    data = _zip_bytes({"ok.txt": b"hello"})
    out = iter_zip_file_members(data, max_uncompressed_bytes=100)
    assert out == [("ok.txt", b"hello")]
