"""Index manager — incremental build + BM25 search (query path is ensure-free)."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from agentcore.workspace._paths import is_ignored_relpath
from agentcore.workspace.indexing.bm25 import BM25Index
from agentcore.workspace.indexing.chunker import chunk_file, detect_language, snippet_preview
from agentcore.workspace.limits import is_liveness_timeout_detail
from agentcore.workspace.protocol import (
    CodeChunk,
    CodeIndexStatus,
    CodeSearchResult,
    IndexFileEntry,
    IndexFilesResult,
    PathNotFound,
    WorkspaceBackend,
    WorkspaceError,
)
from agentcore.workspace.stage_dirs import INDEX_REL

logger = logging.getLogger(__name__)

_INDEX_DB_NAME = "code_search.db"
_MAX_INDEX_FILES = 5000
# Abort one ensure round after this many consecutive channel/liveness timeouts
# so a hung Local read cannot burn ~60s per remaining path.
_ENSURE_ABORT_AFTER_CONSECUTIVE_TIMEOUTS = 2


class IndexManager:
    """Builds and queries the workspace BM25 code index.

    File contents are read through ``WorkspaceBackend`` (not direct disk), so the
    same manager works for ``ServerWorkspace`` and channel-backed ``LocalWorkspace``.
    ``index_dir`` holds the SQLite DB; for local disk workspaces this is typically
    ``<workspace>/AgentCore/index``.

    Build/refresh belongs to ``IndexMaintainer`` (or synchronous ``ensure_index``
    for tests). ``search`` never triggers a build.

    Status is two-axis: a committed queryable snapshot (persisted ``index_meta``)
    versus freshness (dirty / truncated). ``BUILDING`` only when no snapshot
    exists yet and maintenance is in flight.

    When ``index_files`` supplies local-stat fingerprints (mtime_ms + size_bytes),
    ``ensure_index`` skips ``backend.read`` for files whose fingerprint still
    matches the BM25 ``file_hashes`` row — so Local mode does not re-bridge
    unchanged file bodies across the desktop channel.
    """

    def __init__(self, index_dir: str) -> None:
        self._index_dir = str(Path(index_dir))
        self._bm25: BM25Index | None = None
        self._hydrated = False
        self._has_snapshot = False
        self._generation = 0
        self._index_truncated = False
        self._building = False
        self._content_dirty = False

    @classmethod
    def for_workspace_root(cls, workspace_root: str) -> IndexManager:
        """Index beside a real workspace root (``AgentCore/index``)."""
        return cls(str(Path(workspace_root) / Path(*INDEX_REL.split("/"))))

    def _get_bm25(self) -> BM25Index:
        if self._bm25 is None:
            db_path = os.path.join(self._index_dir, _INDEX_DB_NAME)
            self._bm25 = BM25Index(db_path)
        return self._bm25

    def _hydrate_from_db(self, bm25: BM25Index) -> None:
        """Load committed snapshot flags from ``index_meta`` (or legacy rows)."""
        has_snapshot, truncated, generation, dirty = bm25.snapshot_state()
        self._has_snapshot = has_snapshot
        self._index_truncated = truncated
        self._generation = generation
        self._content_dirty = dirty

    def _ensure_hydrated(self) -> BM25Index:
        bm25 = self._get_bm25()
        if not self._hydrated:
            self._hydrate_from_db(bm25)
            self._hydrated = True
        return bm25

    def set_building(self, building: bool) -> None:
        self._building = building

    @property
    def building(self) -> bool:
        return self._building

    def mark_content_dirty(self) -> None:
        """Workspace files changed since the last completed ensure."""
        self._ensure_hydrated()
        self._content_dirty = True
        # Persist across turn/backend rebuild when a committed meta row exists.
        self._get_bm25().mark_meta_dirty_sync()

    @property
    def content_dirty(self) -> bool:
        """True when files changed since the last completed ensure."""
        return self._content_dirty

    @property
    def generation(self) -> int:
        """Committed snapshot generation (0 = none / legacy without meta)."""
        self._ensure_hydrated()
        return self._generation

    @property
    def index_truncated(self) -> bool:
        """True when the committed snapshot was capped (file list truncated)."""
        self._ensure_hydrated()
        return self._index_truncated

    def index_status(self) -> CodeIndexStatus:
        """Compute readiness without running ensure.

        ``BUILDING`` only when no committed snapshot exists yet. A refresh of an
        already-built index stays ``READY`` / ``STALE`` so query keeps serving.
        """
        self._ensure_hydrated()
        if self._building and not self._has_snapshot:
            return CodeIndexStatus.BUILDING
        if not self._has_snapshot or self._index_truncated or self._content_dirty:
            return CodeIndexStatus.STALE
        return CodeIndexStatus.READY

    async def ensure_index(self, backend: WorkspaceBackend, *, force: bool = False) -> bool:
        """Ensure the index is up to date. Returns whether any file was re-indexed."""
        bm25 = self._ensure_hydrated()
        paths, truncated, fingerprints = await self._collect_indexable_paths(backend)

        indexed_paths = await bm25.list_indexed_paths()
        current_set = set(paths)
        updated = False
        consecutive_timeouts = 0

        for stale_path in indexed_paths - current_set:
            await bm25.remove_file(stale_path)
            updated = True

        for path in paths:
            fp = fingerprints.get(path)
            if not force and fp is not None:
                existing_fp = await bm25.get_file_fingerprint(path)
                if existing_fp == fp:
                    # Local-stat fingerprint unchanged → skip channel/disk read.
                    continue

            try:
                text = await backend.read(path)
            except PathNotFound:
                consecutive_timeouts = 0
                if path in indexed_paths:
                    await bm25.remove_file(path)
                    updated = True
                continue
            except WorkspaceError as exc:
                detail = str(exc)
                if is_liveness_timeout_detail(detail):
                    consecutive_timeouts += 1
                    logger.info(
                        "workspace.index_read_timeout path=%s streak=%s",
                        path,
                        consecutive_timeouts,
                    )
                    if consecutive_timeouts >= _ENSURE_ABORT_AFTER_CONSECUTIVE_TIMEOUTS:
                        logger.info(
                            "workspace.index_abort_consecutive_timeouts streak=%s",
                            consecutive_timeouts,
                        )
                        # Incomplete round — persist dirty; keep committed meta.
                        self._content_dirty = True
                        await bm25.mark_meta_dirty()
                        return updated
                    continue
                consecutive_timeouts = 0
                logger.debug("skip indexing %s: %s", path, exc)
                continue

            consecutive_timeouts = 0
            digest = bm25.content_hash(text)
            if not force:
                existing = await bm25.get_file_hash(path)
                if existing == digest:
                    if fp is not None:
                        await bm25.set_file_fingerprint(path, fp[0], fp[1])
                    continue

            language = detect_language(path)
            chunks = await chunk_file(path, text, language)
            mtime_ms = fp[0] if fp is not None else None
            size_bytes = fp[1] if fp is not None else None
            await bm25.upsert_file(
                path, text, chunks, mtime_ms=mtime_ms, size_bytes=size_bytes
            )
            updated = True

        meta = await bm25.commit_meta(truncated=truncated)
        self._has_snapshot = True
        self._generation = int(meta.generation)
        self._index_truncated = truncated
        self._content_dirty = False
        return updated

    async def _collect_indexable_paths(
        self, backend: WorkspaceBackend
    ) -> tuple[list[str], bool, dict[str, tuple[int, int]]]:
        raw = await backend.index_files(cap=_MAX_INDEX_FILES)
        result = _coerce_index_files_result(raw)
        if result.entries:
            kept = [e for e in result.entries if not _should_skip_path(e.path)]
            filtered = [e.path for e in kept]
            fingerprints = IndexFilesResult(
                paths=filtered, truncated=result.truncated, entries=tuple(kept)
            ).fingerprints()
            orig_count = len(result.entries)
        else:
            filtered = [p for p in result.paths if not _should_skip_path(p)]
            fingerprints = {
                p: fp
                for p, fp in result.fingerprints().items()
                if not _should_skip_path(p)
            }
            orig_count = len(result.paths)
        truncated = result.truncated or len(filtered) < orig_count
        return filtered, truncated, fingerprints

    async def search(
        self,
        query: str,
        *,
        language: str | None = None,
        path_prefix: str = ".",
        max_results: int = 10,
    ) -> CodeSearchResult:
        bm25 = self._ensure_hydrated()
        hits = await bm25.search(
            query,
            language=language,
            path_prefix=path_prefix,
            limit=max(1, max_results),
        )

        chunks: list[CodeChunk] = []
        scores: list[float] = []
        for raw, score in hits:
            chunks.append(
                CodeChunk(
                    path=raw.path,
                    symbol=raw.symbol,
                    symbol_type=raw.symbol_type,
                    start_line=raw.start_line,
                    end_line=raw.end_line,
                    language=raw.language,
                    snippet=snippet_preview(raw.content),
                )
            )
            scores.append(score)

        status = self.index_status()
        return CodeSearchResult(
            chunks=chunks,
            scores=scores,
            index_status=status,
            index_stale=status != CodeIndexStatus.READY,
        )


def _coerce_index_files_result(raw: object) -> IndexFilesResult:
    """Accept ``IndexFilesResult`` or legacy ``(paths, truncated)`` tuples from mocks."""
    if isinstance(raw, IndexFilesResult):
        return raw
    if isinstance(raw, tuple) and len(raw) == 2:
        paths, truncated = raw
        return IndexFilesResult(
            paths=[str(p) for p in paths],
            truncated=bool(truncated),
            entries=tuple(IndexFileEntry(path=str(p)) for p in paths),
        )
    raise TypeError(f"index_files returned unexpected type: {type(raw)!r}")


def _should_skip_path(path: str) -> bool:
    """Skip internal zones, noise dirs, and AI/system noise suffixes (e.g. ``.parquet``)."""
    return is_ignored_relpath(path)
