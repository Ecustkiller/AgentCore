"""Archive + manifest helpers shared by storage providers.

A snapshot is a single zip of the workspace tree (regenerable junk pruned). Per
``storage_key`` a small ``manifest.json`` lists the snapshots, so listing is one
object read and does not depend on per-object metadata (which differs across S3
vendors). Manifest writes for one key are serialized by the app's folder-level
``workspace_lock`` at the snapshot sink (决策④ / A′: write serial; read/LLM/prepare
may overlap) — callers of ``create_snapshot`` / restore must not nest another
same-key hold. The read-modify-write here needs no extra coordination for MVP.
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from agentcore.storage.protocol import SnapshotRef
from agentcore.workspace._paths import is_ignored_dir_entry

MANIFEST_NAME = "manifest.json"

# Chunk size for zip member reads (actual-byte gate; avoid loading a full bomb first).
_ZIP_READ_CHUNK = 1024 * 1024


def new_snapshot_id() -> str:
    """Time-sortable id: ``YYYYMMDDTHHMMSSZ-<short>`` (UTC + random suffix)."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{uuid4().hex[:8]}"


class ArchiveLimitError(Exception):
    """Raised when ``zip_dir`` hits a file-count or byte-size gate."""

    def __init__(self, *, reason: str, file_count: int, total_bytes: int) -> None:
        self.reason = reason
        self.file_count = file_count
        self.total_bytes = total_bytes
        super().__init__(f"archive limit exceeded: {reason}")


def zip_dir(
    root: Path,
    *,
    max_files: int | None = None,
    max_bytes: int | None = None,
) -> bytes:
    """Archive a directory tree to in-memory zip bytes.

    Prunes VCS/dependency/cache noise (``IGNORED_DIRS``) and path-aware
    ``AgentCore/{index,trash,baselines,versions}``; skips symlinks so a snapshot
    can't follow a link out of the tree. Paths are stored POSIX-relative to ``root``.

    Optional ``max_files`` / ``max_bytes`` (raw file bytes before zip) align with
    the desktop handoff gate; exceeding either raises :exc:`ArchiveLimitError`.
    """
    buf = io.BytesIO()
    file_count = 0
    total_bytes = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = os.path.relpath(dirpath, root)
            parent_rel = "" if rel_dir == "." else rel_dir.replace("\\", "/")
            dirnames[:] = sorted(
                d for d in dirnames if not is_ignored_dir_entry(parent_rel=parent_rel, name=d)
            )
            for fname in sorted(filenames):
                full = Path(dirpath) / fname
                if full.is_symlink() or not full.is_file():
                    continue
                if max_files is not None and file_count >= max_files:
                    raise ArchiveLimitError(
                        reason="max_files",
                        file_count=file_count,
                        total_bytes=total_bytes,
                    )
                try:
                    size = full.stat().st_size
                except OSError:
                    continue
                if max_bytes is not None and total_bytes + size > max_bytes:
                    raise ArchiveLimitError(
                        reason="max_bytes",
                        file_count=file_count,
                        total_bytes=total_bytes,
                    )
                arcname = full.relative_to(root).as_posix()
                zf.write(full, arcname)
                file_count += 1
                total_bytes += size
    return buf.getvalue()


class ZipSlipError(Exception):
    """Raised when a zip member would escape the extract root (zip-slip)."""

    def __init__(self, member: str) -> None:
        self.member = member
        super().__init__(f"zip-slip rejected: {member}")


class ZipExtractLimitError(Exception):
    """Raised when extract hits a file-count or uncompressed-byte gate."""

    def __init__(self, *, reason: str, file_count: int, total_bytes: int) -> None:
        self.reason = reason
        self.file_count = file_count
        self.total_bytes = total_bytes
        super().__init__(f"zip extract limit exceeded: {reason}")


def zip_member_relpath(member: str) -> str | None:
    """Normalize a zip entry name to a safe relative POSIX file path.

    Returns ``None`` for directory entries (names ending in ``/``). Raises
    :exc:`ZipSlipError` for absolute paths, drive letters, or ``..`` segments.
    """
    raw = member.replace("\\", "/")
    if raw.endswith("/"):
        return None
    # Absolute / UNC / drive-letter shapes must not be joined under the extract root.
    if raw.startswith("/") or raw.startswith("//") or (len(raw) >= 2 and raw[1] == ":"):
        raise ZipSlipError(member)
    parts = [p for p in raw.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        raise ZipSlipError(member)
    return "/".join(parts)


def iter_zip_file_members(
    data: bytes,
    *,
    max_files: int | None = None,
    max_uncompressed_bytes: int | None = None,
) -> list[tuple[str, bytes]]:
    """Return ``(relpath, content)`` for every safe file member (zip-slip → raise).

    Used by ``archive_extract`` (fail-closed). :func:`unzip_into` shares
    :func:`zip_member_relpath` but skips slip entries so storage restore can
    continue. Optional ceilings guard zip bombs.
    """
    out: list[tuple[str, bytes]] = []
    total_bytes = 0
    # Chunked read so a lied-small ``file_size`` cannot force a full bomb into RAM
    # before the actual-byte gate fires.
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            name = info.filename
            rel = zip_member_relpath(name)
            if rel is None:
                continue
            if max_files is not None and len(out) >= max_files:
                raise ZipExtractLimitError(
                    reason="max_files",
                    file_count=len(out),
                    total_bytes=total_bytes,
                )
            # Fast-fail on declared size (honest large members); never the sole gate.
            declared = int(info.file_size)
            if (
                max_uncompressed_bytes is not None
                and total_bytes + declared > max_uncompressed_bytes
            ):
                raise ZipExtractLimitError(
                    reason="max_uncompressed_bytes",
                    file_count=len(out),
                    total_bytes=total_bytes,
                )
            chunks: list[bytes] = []
            actual = 0
            with zf.open(info) as src:
                while True:
                    chunk = src.read(_ZIP_READ_CHUNK)
                    if not chunk:
                        break
                    actual += len(chunk)
                    if (
                        max_uncompressed_bytes is not None
                        and total_bytes + actual > max_uncompressed_bytes
                    ):
                        raise ZipExtractLimitError(
                            reason="max_uncompressed_bytes",
                            file_count=len(out),
                            total_bytes=total_bytes,
                        )
                    chunks.append(chunk)
            content = b"".join(chunks)
            out.append((rel, content))
            total_bytes += actual
    return out


def unzip_into(data: bytes, root: Path) -> None:
    """Extract zip ``data`` over ``root`` (creating it), guarding against zip-slip.

    Slip entries are skipped (storage restore must not abort the whole tree).
    Path resolve is a second containment check after :func:`zip_member_relpath`.
    """
    root.mkdir(parents=True, exist_ok=True)
    root_resolved = root.resolve()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            try:
                rel = zip_member_relpath(info.filename)
            except ZipSlipError:
                continue
            if rel is None:
                continue
            target = (root / rel).resolve()
            # Reject any entry that would land outside the workspace root.
            if target != root_resolved and root_resolved not in target.parents:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())


def manifest_to_bytes(refs: list[SnapshotRef]) -> bytes:
    """Serialize the snapshot list to manifest JSON bytes (newest first)."""
    payload = {
        "snapshots": [
            {
                "snapshot_id": r.snapshot_id,
                "label": r.label,
                "created_at": r.created_at.isoformat(),
                "size_bytes": r.size_bytes,
            }
            for r in refs
        ]
    }
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")


def manifest_from_bytes(data: bytes | None) -> list[SnapshotRef]:
    """Parse manifest bytes into a snapshot list (empty for missing/blank)."""
    if not data:
        return []
    try:
        raw = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return []
    refs: list[SnapshotRef] = []
    for item in raw.get("snapshots", []):
        try:
            refs.append(
                SnapshotRef(
                    snapshot_id=item["snapshot_id"],
                    label=item.get("label"),
                    created_at=datetime.fromisoformat(item["created_at"]),
                    size_bytes=int(item.get("size_bytes", 0)),
                )
            )
        except (KeyError, ValueError, TypeError):
            continue
    return refs
