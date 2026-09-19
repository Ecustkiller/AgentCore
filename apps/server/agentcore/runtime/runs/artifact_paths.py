"""Landed-path kind helpers for the contract gate.

Table / opaque-source suffixes decide the no-exec table gap. This is not a
quality scanner and does not read file text.
"""

from __future__ import annotations

# Spreadsheet / table result files. No-exec data_file_landing must not ship these
# as the product (structural signal at contract; not inferred from file copy).
_DATA_LANDING_TABLE_EXTS = frozenset({".csv", ".xlsx", ".xls", ".tsv"})


def _ext(path: str) -> str:
    name = path.replace("\\", "/").rsplit("/", 1)[-1].casefold()
    if "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[-1]


def is_table_deliverable_path(path: str) -> bool:
    """True when ``path`` is a spreadsheet / table result file (csv / xlsx / …)."""
    return _ext(path) in _DATA_LANDING_TABLE_EXTS


def is_opaque_source_data_path(path: str) -> bool:
    """True when workers cannot reliably parse this file without execution.

    Reuses attachment-parse type buckets (Office/PDF extraction; xlsx/csv/tsv
    structure-preview only). Provenance is decided by the caller — this is not
    a filename guess and not an output-shape conjunction.
    """
    from agentcore.workspace.attachment_parse import MARKITDOWN_EXTENSIONS, TABLE_EXTENSIONS

    return _ext(path) in MARKITDOWN_EXTENSIONS or _ext(path) in TABLE_EXTENSIONS
