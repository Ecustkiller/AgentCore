"""Disk watermark probe for ``/readyz`` observation and patrol alerting.

HTTP 200/503 is decided solely by PostgreSQL. This module never flips readiness.
The sample is attached to the ``/readyz`` body so ops can scrape it, and a
``disk.high_watermark`` warning feeds the log-patrol family at 80%.

Inside a container ``df /`` is often the overlay (image layer / quota), which
does not move with the host volume that Postgres, Redis, and ``DATA_DIR`` share.
We resolve ``settings.data_dir`` against ``/proc/self/mountinfo`` and skip
overlay/tmpfs so the number is the host mount the volume sits on. Usage is
``1 - available/total`` (``f_bavail``) so 0 bytes free for the process is 100%.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.observability.stream_timing import mono_now

logger = get_logger(__name__)

HIGH_WATERMARK_PCT = 80.0
ALERT_INTERVAL_S = 10.0
_MOUNTINFO_PATH = Path("/proc/self/mountinfo")

# Filesystems whose ``statvfs`` is a container/kernel construct, not the host
# volume Postgres checkpoints and Redis AOF actually write.
_VIRTUAL_FS = frozenset(
    {
        "overlay",
        "overlay2",
        "aufs",
        "tmpfs",
        "ramfs",
        "devtmpfs",
        "proc",
        "sysfs",
        "cgroup",
        "cgroup2",
        "devpts",
        "mqueue",
        "hugetlbfs",
        "pstore",
        "binfmt_misc",
        "securityfs",
        "debugfs",
        "tracefs",
        "fusectl",
        "configfs",
        "nsfs",
        "squashfs",
        "fuse.lxcfs",
    }
)

_high_active = False
_high_last_mono: float | None = None
_high_suppressed = 0
_fail_last_mono: float | None = None
_fail_suppressed = 0


@dataclass(frozen=True, slots=True)
class Mount:
    """One ``/proc/self/mountinfo`` row (mountpoint + fstype only)."""

    mountpoint: str
    fstype: str


@dataclass(frozen=True, slots=True)
class DiskProbeTarget:
    """Resolved path to ``statvfs``, plus whether it sat on overlay."""

    path: str
    fstype: str | None
    overlay: bool


@dataclass(frozen=True, slots=True)
class DiskSample:
    """One observational watermark. ``used_pct is None`` means the probe failed."""

    path: str
    used_pct: float | None
    total_bytes: int | None = None
    free_bytes: int | None = None
    fstype: str | None = None
    overlay: bool = False
    error: str | None = None

    def to_readyz_field(self) -> dict[str, object]:
        body: dict[str, object] = {
            "used_pct": None if self.used_pct is None else round(self.used_pct, 1),
            "path": self.path,
        }
        if self.overlay:
            body["overlay"] = True
        if self.error:
            body["error"] = self.error
        return body


def _unescape_mount_field(value: str) -> str:
    return (
        value.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
    )


def _norm_path(value: str) -> str:
    text = value.replace("\\", "/")
    if text != "/":
        text = text.rstrip("/")
    return text or "/"


def parse_mountinfo(text: str) -> list[Mount]:
    """Parse kernel ``mountinfo``; malformed lines are skipped."""
    mounts: list[Mount] = []
    for raw in text.splitlines():
        if " - " not in raw:
            continue
        left, right = raw.split(" - ", 1)
        left_parts = left.split()
        right_parts = right.split()
        if len(left_parts) < 5 or not right_parts:
            continue
        mounts.append(
            Mount(
                mountpoint=_unescape_mount_field(left_parts[4]),
                fstype=right_parts[0],
            )
        )
    return mounts


def covering_mount(path: str, mounts: Sequence[Mount]) -> Mount | None:
    """Longest mountpoint prefix of ``path`` (POSIX-style, as in mountinfo)."""
    needle = _norm_path(path)
    best: Mount | None = None
    best_len = -1
    for mount in mounts:
        mp = _norm_path(mount.mountpoint)
        if (needle == mp or needle.startswith(mp + "/") or mp == "/") and len(mp) > best_len:
            best = mount
            best_len = len(mp)
    return best


def read_mountinfo_text() -> str | None:
    try:
        return _MOUNTINFO_PATH.read_text(encoding="utf-8")
    except OSError:
        return None


def _existing_path(data_dir: str) -> str:
    path = Path(data_dir)
    if path.exists():
        return str(path)
    parent = path.parent
    if parent.exists():
        return str(parent)
    return str(Path.cwd())


def resolve_disk_probe_path(
    data_dir: str,
    *,
    mountinfo_text: str | None = None,
) -> DiskProbeTarget:
    """Pick the host volume under ``data_dir``; skip overlay/tmpfs when listed.

    When ``/proc/self/mountinfo`` is missing (Windows / non-Linux), fall back to
    an existing path under ``data_dir`` — that *is* the real disk locally.
    """
    text = mountinfo_text if mountinfo_text is not None else read_mountinfo_text()
    mounts = parse_mountinfo(text) if text else []
    existing = _existing_path(data_dir)
    if not mounts:
        return DiskProbeTarget(path=existing, fstype=None, overlay=False)

    covering = covering_mount(data_dir, mounts)
    if covering is None:
        covering = covering_mount(existing, mounts)
    if covering is not None and covering.fstype not in _VIRTUAL_FS:
        probe = covering.mountpoint
        if not Path(probe).exists():
            probe = existing
        return DiskProbeTarget(path=probe, fstype=covering.fstype, overlay=False)
    fstype = covering.fstype if covering is not None else None
    overlay = fstype in _VIRTUAL_FS if fstype else False
    return DiskProbeTarget(path=existing, fstype=fstype, overlay=overlay)


def _device_id(path: str) -> int | None:
    try:
        return os.stat(path).st_dev
    except OSError:
        return None


def _usage_pct(total: int, free: int) -> float:
    if total <= 0:
        return 0.0
    return (1.0 - (free / total)) * 100.0


def _sample_target(target: DiskProbeTarget) -> DiskSample:
    try:
        usage = shutil.disk_usage(target.path)
    except OSError as exc:
        return DiskSample(
            path=target.path,
            used_pct=None,
            fstype=target.fstype,
            overlay=target.overlay,
            error=str(exc),
        )
    return DiskSample(
        path=target.path,
        used_pct=_usage_pct(usage.total, usage.free),
        total_bytes=usage.total,
        free_bytes=usage.free,
        fstype=target.fstype,
        overlay=target.overlay,
    )


def _worse(left: DiskSample, right: DiskSample) -> DiskSample:
    left_pct = -1.0 if left.used_pct is None else left.used_pct
    right_pct = -1.0 if right.used_pct is None else right.used_pct
    return right if right_pct > left_pct else left


def probe_disk(
    *,
    data_dir: str | None = None,
    mountinfo_text: str | None = None,
) -> DiskSample:
    """Read watermark for ``data_dir``; also ``/`` when that is a distinct real FS."""
    raw = settings.data_dir if data_dir is None else data_dir
    text = mountinfo_text if mountinfo_text is not None else read_mountinfo_text()
    primary = _sample_target(resolve_disk_probe_path(raw, mountinfo_text=text))
    if not text:
        return primary
    root_target = resolve_disk_probe_path("/", mountinfo_text=text)
    if root_target.overlay:
        return primary
    root_dev = _device_id(root_target.path)
    primary_dev = _device_id(primary.path)
    if root_dev is None or root_dev == primary_dev:
        return primary
    return _worse(primary, _sample_target(root_target))


def _due(last_mono: float | None, now: float) -> bool:
    return last_mono is None or (now - last_mono) >= ALERT_INTERVAL_S


def _maybe_alert(sample: DiskSample, *, now_mono: float | None = None) -> None:
    """First crossing / failure always logs; repeats at most every 10s."""
    global _high_active, _high_last_mono, _high_suppressed
    global _fail_last_mono, _fail_suppressed
    now = mono_now() if now_mono is None else now_mono
    if sample.error or sample.used_pct is None:
        _high_active = False
        _high_last_mono = None
        _high_suppressed = 0
        if not _due(_fail_last_mono, now):
            _fail_suppressed += 1
            return
        logger.warning(
            "disk.probe_failed",
            path=sample.path,
            error=sample.error or "used_pct unavailable",
            suppressed=_fail_suppressed,
        )
        _fail_last_mono = now
        _fail_suppressed = 0
        return

    _fail_last_mono = None
    _fail_suppressed = 0
    used = round(sample.used_pct, 1)
    if used < HIGH_WATERMARK_PCT:
        _high_active = False
        _high_last_mono = None
        _high_suppressed = 0
        return
    if _high_active and not _due(_high_last_mono, now):
        _high_suppressed += 1
        return
    logger.warning(
        "disk.high_watermark",
        used_pct=used,
        path=sample.path,
        total_bytes=sample.total_bytes,
        free_bytes=sample.free_bytes,
        fstype=sample.fstype,
        overlay=sample.overlay,
        threshold_pct=HIGH_WATERMARK_PCT,
        suppressed=_high_suppressed,
        reason=f"used_pct={used} >= {HIGH_WATERMARK_PCT} path={sample.path}",
    )
    _high_active = True
    _high_last_mono = now
    _high_suppressed = 0


def observe_disk() -> DiskSample:
    """Probe + maybe warn. Safe to call on every ``/readyz``; never raises."""
    try:
        sample = probe_disk()
    except Exception as exc:
        sample = DiskSample(path=settings.data_dir, used_pct=None, error=str(exc))
    _maybe_alert(sample)
    return sample
