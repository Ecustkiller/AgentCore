"""Workspace code indexing — tree-sitter chunking + BM25 (SQLite FTS5)."""

from agentcore.workspace.indexing.bm25 import BM25Index
from agentcore.workspace.indexing.chunker import RawChunk, chunk_file
from agentcore.workspace.indexing.maintainer import IndexMaintainer
from agentcore.workspace.indexing.manager import IndexManager
from agentcore.workspace.indexing.registry import (
    clear_index_registry,
    drop_index_registry,
    shared_index_maintainer,
    shared_index_maintainer_for_dir,
    shared_index_manager,
    shared_index_manager_for_dir,
)

__all__ = [
    "BM25Index",
    "IndexMaintainer",
    "IndexManager",
    "RawChunk",
    "chunk_file",
    "clear_index_registry",
    "drop_index_registry",
    "shared_index_maintainer",
    "shared_index_maintainer_for_dir",
    "shared_index_manager",
    "shared_index_manager_for_dir",
]
