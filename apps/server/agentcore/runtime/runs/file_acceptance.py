"""Path-level delivery acceptance for files_touched (验收态 · 块 1 / 块 2).

At run wrap-up each landed path gets ``accepted`` or ``rejected`` (+ reason).
``delivery_status.delivered_files`` / CEO「已交付」only count ``accepted``.
Cite-tier / contract failures that name a path reject that path even when the
run soft-COMPLETEDs — so soft-COMPLETED must not smuggle those paths into the
delivered list.

调研两阶段（``citation_mode=two_phase``）：阶段 A 草案仅内部态，不写入本表；
阶段 B 过闸 → ``accepted``；不过 → ``rejected(citations_unverified)``。draft 永不
出现在 ``delivery_status.artifacts`` 主清单。
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from agentcore.runtime.runs.types import RunPhase
from agentcore.tools.file_products import FileProduct

REASON_CITATIONS_UNVERIFIED = "citations_unverified"
REASON_CONTRACT_FAILED = "contract_failed"
REASON_RUN_FAILED = "run_failed"

# Citation / bibliography failures from ``_artifact_citation_failures``.
_CITE_PATH_RE = re.compile(r"^`([^`]+)`\s*[：:]\s*(.*)$", re.DOTALL)
# Hard placeholder (and similar) hit lines embed ``path`` · label · …
_EMBEDDED_PATH_RE = re.compile(r"`([^`]+)`\s*·")
_SOFT_NOTE_MARKERS = (
    "待核实",
    "示例自注",
    "不阻断验收",
    "含未替换骨架占位",
    "篇幅提醒（软）",
    "素材覆盖提醒（软）",
    "契约软提醒",
)


def path_rejections_from_contract_messages(
    messages: list[str] | None,
) -> dict[str, tuple[str, str]]:
    """Map path → (reason_code, detail) from contract failure / soft_failure copy.

    Soft reminder notes (待核实等) never reject — only hard / cite-shaped messages.
    """
    out: dict[str, tuple[str, str]] = {}
    for raw in messages or []:
        text = str(raw).strip()
        if not text:
            continue
        cite = _CITE_PATH_RE.match(text)
        if cite:
            path = cite.group(1).strip()
            detail = (cite.group(2) or "").strip() or text
            if path:
                out[path] = (REASON_CITATIONS_UNVERIFIED, detail)
            continue
        if any(m in text for m in _SOFT_NOTE_MARKERS):
            continue
        for path in _EMBEDDED_PATH_RE.findall(text):
            p = path.strip()
            if p and p not in out:
                out[p] = (REASON_CONTRACT_FAILED, text)
    return out


def build_file_acceptance(
    files_touched: list[str] | None,
    *,
    phase: RunPhase,
    error: str = "",
    path_rejections: dict[str, tuple[str, str]] | None = None,
    products: Sequence[FileProduct] | None = None,
) -> list[dict[str, Any]]:
    """Build ordered ``[{path, status, kind?, derived_from?, reason?, detail?}]``.

    ``products`` is the run's self-reported产物 (``file_products_from_transcript``);
    matching rows carry the producer's own ``kind`` (docx / md / code / …) and
    ``derived_from`` (this product is an EXPORT of that source file). Callers without
    products (older frames / tests) still get the path-only rows.
    """
    touched = [p for p in (files_touched or []) if p]
    if not touched:
        return []
    rejections = dict(path_rejections or {})
    by_path = {p.path: p for p in (products or []) if p.path}
    out: list[dict[str, Any]] = []

    def _row(path: str) -> dict[str, Any]:
        row: dict[str, Any] = {"path": path}
        product = by_path.get(path)
        if product is not None:
            if product.kind:
                row["kind"] = product.kind
            if product.derived_from:
                row["derived_from"] = product.derived_from
        return row

    if phase is RunPhase.FAILED:
        err = (error or "").strip() or "run failed"
        for path in touched:
            reason, detail = rejections.get(path, (REASON_RUN_FAILED, err))
            row = _row(path)
            row["status"] = "rejected"
            row["reason"] = reason
            if detail:
                row["detail"] = detail
            out.append(row)
        return out

    for path in touched:
        row = _row(path)
        if path in rejections:
            reason, detail = rejections[path]
            row["status"] = "rejected"
            row["reason"] = reason
            if detail:
                row["detail"] = detail
        else:
            row["status"] = "accepted"
        out.append(row)
    return out


def accepted_paths(file_acceptance: list[dict[str, Any]] | None) -> list[str]:
    """Paths with status=accepted (stable order)."""
    out: list[str] = []
    for row in file_acceptance or []:
        if not isinstance(row, dict):
            continue
        if row.get("status") == "accepted" and row.get("path"):
            out.append(str(row["path"]))
    return out


def fold_exported_sources(
    file_acceptance: list[dict[str, Any]] | None,
) -> tuple[list[str], list[str]]:
    """Split accepted paths into ``(主推件, 被折叠的中间稿)``.

    An accepted product whose ``derived_from`` names another accepted path says
    「我是那份源文件的导出件」（``md_to_docx``：docx ← 源 md）。用户要的是导出件，源文件
    只是中间稿——同列两份会让答复把 ``.md`` 说成「Word 文档」的位置（真实事故）。折叠只认
    自报的 ``derived_from``：不看扩展名、不看工具名，没自报就一份都不降级。

    导出件本身永不被藏：源文件没被验收（导出件是唯一产物）时无从折叠；自报成环导致主推
    清单会被清空时整体不折叠。
    """
    accepted = accepted_paths(file_acceptance)
    if not accepted:
        return [], []
    accepted_set = set(accepted)
    sources: set[str] = set()
    for row in file_acceptance or []:
        if not isinstance(row, dict) or row.get("status") != "accepted":
            continue
        path = str(row.get("path") or "").strip()
        source = str(row.get("derived_from") or "").strip()
        if not source or source == path:
            continue
        if source in accepted_set:
            sources.add(source)
    if not sources:
        return accepted, []
    primary = [p for p in accepted if p not in sources]
    if not primary:
        return accepted, []
    return primary, [p for p in accepted if p in sources]


def normalize_acceptance_row(row: dict[str, Any]) -> dict[str, Any] | None:
    """Wire-safe artifact row, or None if unusable."""
    if not isinstance(row, dict):
        return None
    path = str(row.get("path") or "").strip()
    status = str(row.get("status") or "").strip()
    if not path or status not in ("accepted", "rejected"):
        return None
    out: dict[str, Any] = {"path": path, "status": status}
    reason = str(row.get("reason") or "").strip()
    if reason:
        out["reason"] = reason
    detail = str(row.get("detail") or "").strip()
    if detail:
        out["detail"] = detail
    return out
