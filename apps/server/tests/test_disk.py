"""Disk watermark: host-mount resolution, 80% alert, never a readiness flip."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agentcore.observability import disk as disk_mod
from agentcore.observability.disk import (
    HIGH_WATERMARK_PCT,
    DiskSample,
    covering_mount,
    observe_disk,
    parse_mountinfo,
    probe_disk,
    resolve_disk_probe_path,
)
from agentcore.observability.events import get_registry
from tests.conftest import LogSpy

_OVERLAY_AND_DATA = (
    "1 0 0:1 / / rw,relatime - overlay overlay rw,lowerdir=/x\n"
    "2 1 8:1 /var/lib/docker/volumes/appdata/_data /data rw,relatime - ext4 /dev/vda1 rw\n"
)
_OVERLAY_ONLY = "1 0 0:1 / / rw,relatime - overlay overlay rw\n"


@pytest.fixture
def reset_alerts(monkeypatch):
    monkeypatch.setattr(disk_mod, "_high_active", False)
    monkeypatch.setattr(disk_mod, "_high_last_mono", None)
    monkeypatch.setattr(disk_mod, "_high_suppressed", 0)
    monkeypatch.setattr(disk_mod, "_fail_last_mono", None)
    monkeypatch.setattr(disk_mod, "_fail_suppressed", 0)


def test_high_watermark_event_is_registered():
    names = get_registry().names()
    assert "disk.high_watermark" in names
    assert "disk.probe_failed" in names
    fields = get_registry().requires("disk.high_watermark").fields
    assert "used_pct" in fields
    assert "path" in fields
    assert "threshold_pct" in fields


def test_parse_mountinfo_reads_mountpoint_and_fstype():
    mounts = parse_mountinfo(_OVERLAY_AND_DATA)
    by_mp = {m.mountpoint: m.fstype for m in mounts}
    assert by_mp["/"] == "overlay"
    assert by_mp["/data"] == "ext4"


def test_covering_mount_prefers_longest_prefix():
    mounts = parse_mountinfo(_OVERLAY_AND_DATA)
    hit = covering_mount("/data/workspaces", mounts)
    assert hit is not None
    assert hit.mountpoint == "/data"
    assert hit.fstype == "ext4"
    root = covering_mount("/", mounts)
    assert root is not None
    assert root.fstype == "overlay"


def test_resolve_skips_overlay_root_for_data_volume():
    target = resolve_disk_probe_path("/data", mountinfo_text=_OVERLAY_AND_DATA)
    assert target.overlay is False
    assert target.fstype == "ext4"


def test_resolve_marks_overlay_when_no_host_volume():
    target = resolve_disk_probe_path("/data", mountinfo_text=_OVERLAY_ONLY)
    assert target.overlay is True
    assert target.fstype == "overlay"


def test_used_pct_uses_available_bytes_not_df_used(tmp_path, monkeypatch):
    """0 bytes available to the process is 100%, even if root-reserved remains."""
    data = tmp_path / "data"
    data.mkdir()
    usage = SimpleNamespace(total=1000, used=500, free=100)
    monkeypatch.setattr(disk_mod.shutil, "disk_usage", lambda _p: usage)
    sample = probe_disk(data_dir=str(data), mountinfo_text="")
    assert sample.used_pct == 90.0
    assert sample.overlay is False


def test_probe_prefers_non_overlay_mount(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    posix = str(data).replace("\\", "/")
    text = (
        "1 0 0:1 / / rw - overlay overlay rw\n"
        f"2 1 8:1 / {posix} rw - ext4 /dev/sda1 rw\n"
    )
    sample = probe_disk(data_dir=str(data), mountinfo_text=text)
    assert sample.overlay is False
    assert sample.fstype == "ext4"
    assert sample.used_pct is not None
    assert sample.error is None


def test_observe_logs_high_watermark(monkeypatch, reset_alerts):
    spy = LogSpy()
    monkeypatch.setattr(disk_mod, "logger", spy)
    monkeypatch.setattr(
        disk_mod,
        "probe_disk",
        lambda: DiskSample(
            path="/data",
            used_pct=81.4,
            total_bytes=1000,
            free_bytes=186,
            fstype="ext4",
        ),
    )
    sample = observe_disk()
    assert sample.used_pct == 81.4
    logged = spy.get("disk.high_watermark")
    assert logged["used_pct"] == 81.4
    assert logged["threshold_pct"] == HIGH_WATERMARK_PCT
    assert logged["path"] == "/data"
    assert logged["suppressed"] == 0


def test_high_watermark_coalesces_within_interval(monkeypatch, reset_alerts):
    spy = LogSpy()
    monkeypatch.setattr(disk_mod, "logger", spy)
    sample = DiskSample(
        path="/data",
        used_pct=85.0,
        total_bytes=1000,
        free_bytes=150,
        fstype="ext4",
    )
    disk_mod._maybe_alert(sample, now_mono=0.0)
    disk_mod._maybe_alert(sample, now_mono=1.0)
    disk_mod._maybe_alert(sample, now_mono=10.0)
    events = [name for name, _ in spy.events]
    assert events == ["disk.high_watermark", "disk.high_watermark"]
    assert spy.events[1][1]["suppressed"] == 1


def test_below_threshold_does_not_log(monkeypatch, reset_alerts):
    spy = LogSpy()
    monkeypatch.setattr(disk_mod, "logger", spy)
    disk_mod._maybe_alert(
        DiskSample(path="/data", used_pct=79.9, total_bytes=1000, free_bytes=201),
        now_mono=0.0,
    )
    assert spy.events == []


def test_probe_failed_logs_without_raising(monkeypatch, reset_alerts):
    spy = LogSpy()
    monkeypatch.setattr(disk_mod, "logger", spy)
    monkeypatch.setattr(
        disk_mod,
        "probe_disk",
        lambda: DiskSample(path="/data", used_pct=None, error="Permission denied"),
    )
    sample = observe_disk()
    assert sample.used_pct is None
    logged = spy.get("disk.probe_failed")
    assert "Permission denied" in logged["error"]
