"""fetch_runsc.py: official releases are a tarball, not a lone runsc binary."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import tarfile
from pathlib import Path

import pytest

_SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "fetch_runsc.py"
)


def _load():
    spec = importlib.util.spec_from_file_location("fetch_runsc", _SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tar_bz2(*files: tuple[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tf:
        for name, payload in files:
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o755
            tf.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


@pytest.fixture
def fetch_mod():
    return _load()


def test_default_url_is_official_tarball(fetch_mod):
    assert fetch_mod._DEFAULT_URL.endswith("gvisor.tar.bz2")
    assert not fetch_mod._DEFAULT_URL.endswith("/runsc")


def test_extracts_runsc_and_gvisor_bin(tmp_path, monkeypatch, fetch_mod):
    archive = _tar_bz2(
        ("runsc", b"runsc-bytes"),
        ("gvisor-bin/helper", b"sidecar"),
        ("containerd-shim-runsc-v1", b"shim-must-skip"),
    )
    digest = hashlib.sha512(archive).hexdigest()
    monkeypatch.setenv("RUNSC_SHA512", digest)
    monkeypatch.setenv(
        "RUNSC_URL",
        "https://example.invalid/gvisor.tar.bz2",
    )
    monkeypatch.setattr(
        fetch_mod.urllib.request,
        "urlopen",
        lambda url, timeout=600: io.BytesIO(archive),
    )
    out = tmp_path / "runsc"
    fetch_mod.install_runsc(str(out))
    assert out.read_bytes() == b"runsc-bytes"
    assert (tmp_path / "gvisor-bin" / "helper").read_bytes() == b"sidecar"
    assert not (tmp_path / "containerd-shim-runsc-v1").exists()


def test_rejects_archive_without_gvisor_bin(tmp_path, monkeypatch, fetch_mod):
    archive = _tar_bz2(("runsc", b"only"))
    monkeypatch.setenv("RUNSC_SHA512", "skip")
    monkeypatch.setenv("RUNSC_URL", "https://example.invalid/gvisor.tar.bz2")
    monkeypatch.setattr(
        fetch_mod.urllib.request,
        "urlopen",
        lambda url, timeout=600: io.BytesIO(archive),
    )
    with pytest.raises(SystemExit, match="gvisor-bin"):
        fetch_mod.install_runsc(str(tmp_path / "runsc"))


def test_skips_path_traversal_members(tmp_path, monkeypatch, fetch_mod):
    archive = _tar_bz2(
        ("runsc", b"ok"),
        ("gvisor-bin/ok", b"side"),
        ("../evil", b"nope"),
        ("gvisor-bin/../../outside", b"nope"),
    )
    monkeypatch.setenv("RUNSC_SHA512", "skip")
    monkeypatch.setenv("RUNSC_URL", "https://example.invalid/gvisor.tar.bz2")
    monkeypatch.setattr(
        fetch_mod.urllib.request,
        "urlopen",
        lambda url, timeout=600: io.BytesIO(archive),
    )
    fetch_mod.install_runsc(str(tmp_path / "runsc"))
    assert (tmp_path / "runsc").read_bytes() == b"ok"
    assert not (tmp_path / "evil").exists()
    assert not (tmp_path.parent / "outside").exists()
    assert not (tmp_path.parent / "evil").exists()


def test_legacy_raw_runsc_url_writes_single_file(tmp_path, monkeypatch, fetch_mod):
    payload = b"legacy-runsc"
    monkeypatch.setenv("RUNSC_SHA512", "skip")
    monkeypatch.setenv(
        "RUNSC_URL",
        "https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc",
    )
    monkeypatch.setattr(
        fetch_mod.urllib.request,
        "urlopen",
        lambda url, timeout=600: io.BytesIO(payload),
    )
    out = tmp_path / "runsc"
    fetch_mod.install_runsc(str(out))
    assert out.read_bytes() == payload
    assert not (tmp_path / "gvisor-bin").exists()
