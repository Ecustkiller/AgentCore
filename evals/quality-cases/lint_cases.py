#!/usr/bin/env python3
"""Zero-LLM structural lint for evals/quality-cases (Q7).

Hard findings fail the process (exit 1) and are what the backend pytest wrapper
runs. Warn findings print but never change the exit code.

Usage (repo root):
  python evals/quality-cases/lint_cases.py
  python evals/quality-cases/lint_cases.py --hard-only
  python evals/quality-cases/lint_cases.py path/to/file.json
  python evals/quality-cases/lint_cases.py path/to/dir
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal

ROOT = Path(__file__).resolve().parent
CASES_DIR = ROOT / "cases"

SCHEMA_VERSION = 1
ID_RE = re.compile(r"^qc-([0-9]{8})-([a-z0-9]+(?:-[a-z0-9]+)*)$")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
AT_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)?$")
TRACE_RE = re.compile(r"^[0-9a-f]{32}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
KNOB_RE = re.compile(r"^[a-z][a-z0-9_]*:[a-z0-9_./-]+$", re.I)

STATUSES = frozenset({"open", "triaged", "reproduced", "fixed", "regressed", "closed"})
VERDICTS = frozenset({"undecided", "defect", "noise", "honest_refusal", "wont_fix"})
NON_DEFECT = frozenset({"noise", "honest_refusal", "wont_fix"})
OPENED_BY = frozenset({"patrol", "feedback", "manual"})
SIGNAL_TIERS = frozenset({"production", "dogfood", "L1_synthetic"})
REPRO_TIERS = frozenset({"production", "dogfood", "L1_synthetic"})
FIX_CLASSES = frozenset({"structural", "observe", "intercept", "other"})
CLOSE_REASONS = frozenset({"resolved", "not_a_defect", "wont_fix", "duplicate", "abandoned"})
CLOSED_DEFECT_REASONS = frozenset({"resolved", "abandoned", "duplicate"})
CLOSED_NON_DEFECT_REASONS = frozenset({"not_a_defect", "wont_fix"})

# Discipline 5 — executable subset. Semantic redaction remains human (§九.2).
SYMPTOM_MAX = 200
NOTE_MAX = 400
FAMILY_CANDIDATE_MAX = 120
INTERCEPT_FIELD_MAX = 400

INTERCEPT_FIELDS = (
    "false_positive_surface",
    "why_ladder_insufficient",
    "soft_net_negative",
)
PREVIEW_KEYS = frozenset({"first_user_preview", "last_user_preview"})
RATE_KEYS = frozenset({"rate", "pct", "percentage"})
RATE_KEY_RE = re.compile(r"(^|_)(rate|pct|percentage)(_|$)", re.I)
WARN_RATIO_RE = re.compile(r"%|占比|显著")

# 疑似正文：对话角色标记 / 快照预览字段名 / 消息 JSON 残片。
BODY_RES = (
    re.compile(r"first_user_preview|last_user_preview"),
    re.compile(r'(?i)"role"\s*:\s*"(user|assistant|human)"'),
    re.compile(r"(?m)^(user|assistant|human|system)\s*[:：]", re.I),
    re.compile(r"(用户原文|消息正文|LLM\s*正文|用户预览)"),
    re.compile(r"(?m)(^|[\n。；;])(用户|助手|助理)[：:]"),
)

REQUIRED_TOP = (
    "schema_version",
    "id",
    "opened_at",
    "opened_by",
    "symptom",
    "family",
    "family_candidate",
    "suspected_knobs",
    "knobs_changed",
    "evidence",
    "verdict",
    "verdict_note",
    "fix_class",
    "intercept_proposal",
    "disposition",
    "duplicate_of",
    "status",
    "close_reason",
    "history",
)
EVIDENCE_KEYS = ("traces", "conversations", "occurrence_log", "signal_tier", "repro_tier")
DISPOSITION_KEYS = (
    "eval_cases",
    "conformance_vectors",
    "dogfood_slots",
    "family_entry",
    "fix_commits",
)
HISTORY_KEYS = ("at", "status", "verdict", "note")
OCCURRENCE_KEYS = ("window", "n")

Level = Literal["hard", "warn"]


@dataclass(frozen=True)
class Finding:
    level: Level
    code: str
    path: str
    message: str

    def format(self) -> str:
        return f"{self.level.upper()}: {self.path}: [{self.code}] {self.message}"


class _Collector:
    def __init__(self, source: str) -> None:
        self.source = source
        self.findings: list[Finding] = []

    def hard(self, code: str, loc: str, message: str) -> None:
        self.findings.append(Finding("hard", code, f"{self.source}:{loc}", message))

    def warn(self, code: str, loc: str, message: str) -> None:
        self.findings.append(Finding("warn", code, f"{self.source}:{loc}", message))


def _walk_keys(obj: Any, prefix: str = "") -> Iterable[tuple[str, str, Any]]:
    if isinstance(obj, dict):
        for key, val in obj.items():
            loc = f"{prefix}.{key}" if prefix else str(key)
            yield loc, str(key), val
            yield from _walk_keys(val, loc)
    elif isinstance(obj, list):
        for i, val in enumerate(obj):
            yield from _walk_keys(val, f"{prefix}[{i}]")


def _repro_pointers(disposition: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for key in ("eval_cases", "conformance_vectors", "dogfood_slots"):
        items = disposition.get(key)
        if isinstance(items, list):
            out.extend(x for x in items if isinstance(x, str) and x.strip())
    return out


def _evidence_nonempty(evidence: dict[str, Any]) -> bool:
    traces = evidence.get("traces")
    conversations = evidence.get("conversations")
    log = evidence.get("occurrence_log")
    return bool(traces) or bool(conversations) or bool(log)


def _slug_of(case_id: str) -> str:
    match = ID_RE.match(case_id)
    return match.group(2) if match else case_id


def _check_free_text(col: _Collector, loc: str, text: str, *, limit: int) -> None:
    if len(text) > limit:
        col.hard(
            "body",
            loc,
            f"自由文字超过 {limit} 字（纪律 5 长度上限，got {len(text)}）",
        )
    for pat in BODY_RES:
        if pat.search(text):
            col.hard("body", loc, "疑似正文形态（纪律 5）")
            break
    if WARN_RATIO_RE.search(text):
        col.warn("ratio_wording", loc, "自由文含 % / 占比 / 显著（纪律 4 warn，不挡 PR）")


def _check_rate_and_preview_keys(col: _Collector, data: Any) -> None:
    for loc, key, _val in _walk_keys(data):
        lowered = key.lower()
        if key in PREVIEW_KEYS or lowered in PREVIEW_KEYS:
            col.hard("body", loc, "禁止出现快照用户预览字段（纪律 5 / Q8）")
        if lowered in RATE_KEYS or RATE_KEY_RE.search(key):
            col.hard("rate_field", loc, f"禁止比率字段 {key!r}（纪律 4）")


def _check_shape(col: _Collector, data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        col.hard("schema", "$", "案卡必须是 JSON object")
        return None
    extra = set(data) - set(REQUIRED_TOP)
    for key in sorted(extra):
        if key.lower() in RATE_KEYS or RATE_KEY_RE.search(key):
            continue
        if key in PREVIEW_KEYS:
            continue
        col.hard("schema", key, f"未知顶层字段 {key!r}")
    missing = [k for k in REQUIRED_TOP if k not in data]
    if missing:
        col.hard("schema", "$", f"缺必填字段: {', '.join(missing)}")
        return None
    if data.get("schema_version") != SCHEMA_VERSION:
        col.hard("schema", "schema_version", f"必须为 {SCHEMA_VERSION}")
    return data


def _check_id_and_meta(col: _Collector, data: dict[str, Any], *, filename: str | None) -> None:
    case_id = data.get("id")
    if not isinstance(case_id, str) or not ID_RE.match(case_id):
        col.hard("id_format", "id", "id 必须是 qc-<YYYYMMDD>-<slug>（小写 slug）")
    elif filename is not None and filename != f"{case_id}.json":
        col.hard("id_format", "id", f"文件名必须是 {case_id}.json")

    opened_at = data.get("opened_at")
    if not isinstance(opened_at, str) or not DATE_RE.match(opened_at):
        col.hard("schema", "opened_at", "必须是 YYYY-MM-DD")

    if data.get("opened_by") not in OPENED_BY:
        col.hard("schema", "opened_by", "必须是 patrol | feedback | manual")

    status = data.get("status")
    if status not in STATUSES:
        col.hard("schema", "status", f"非法 status {status!r}")
    verdict = data.get("verdict")
    if verdict not in VERDICTS:
        col.hard("schema", "verdict", f"非法 verdict {verdict!r}")

    close_reason = data.get("close_reason")
    if close_reason is not None and close_reason not in CLOSE_REASONS:
        col.hard("schema", "close_reason", f"非法 close_reason {close_reason!r}")

    if data.get("fix_class") not in FIX_CLASSES and data.get("fix_class") is not None:
        col.hard("schema", "fix_class", "必须是 structural|observe|intercept|other|null")

    dup = data.get("duplicate_of")
    if dup is not None and (not isinstance(dup, str) or not ID_RE.match(dup)):
        col.hard("duplicate_of", "duplicate_of", "必须是 qc-<YYYYMMDD>-<slug> 或 null")


def _check_lists_and_evidence(col: _Collector, data: dict[str, Any]) -> None:
    for key in ("suspected_knobs", "knobs_changed"):
        val = data.get(key)
        if not isinstance(val, list) or not all(isinstance(x, str) and x.strip() for x in val):
            col.hard("schema", key, "必须是非空字符串数组")
            continue
        for i, item in enumerate(val):
            if not KNOB_RE.match(item):
                col.hard("schema", f"{key}[{i}]", "旋钮名形如 kind:name")

    evidence = data.get("evidence")
    if not isinstance(evidence, dict):
        col.hard("schema", "evidence", "必须是 object")
        return
    extra = set(evidence) - set(EVIDENCE_KEYS)
    for key in sorted(extra):
        if key.lower() in RATE_KEYS or RATE_KEY_RE.search(key) or key in PREVIEW_KEYS:
            continue
        col.hard("schema", f"evidence.{key}", f"未知字段 {key!r}")
    for key in EVIDENCE_KEYS:
        if key not in evidence:
            col.hard("schema", f"evidence.{key}", "缺字段")

    traces = evidence.get("traces")
    if not isinstance(traces, list) or not all(isinstance(x, str) for x in traces):
        col.hard("schema", "evidence.traces", "必须是字符串数组")
    else:
        for i, item in enumerate(traces):
            if not TRACE_RE.match(item):
                col.hard("schema", f"evidence.traces[{i}]", "trace_id 必须是 32 位 hex")

    conversations = evidence.get("conversations")
    if not isinstance(conversations, list) or not all(isinstance(x, str) for x in conversations):
        col.hard("schema", "evidence.conversations", "必须是字符串数组")
    else:
        for i, item in enumerate(conversations):
            if not UUID_RE.match(item):
                col.hard("schema", f"evidence.conversations[{i}]", "conversation_id 必须是 UUID")

    log = evidence.get("occurrence_log")
    if not isinstance(log, list):
        col.hard("schema", "evidence.occurrence_log", "必须是数组")
    else:
        for i, row in enumerate(log):
            loc = f"evidence.occurrence_log[{i}]"
            if not isinstance(row, dict):
                col.hard("schema", loc, "必须是 object")
                continue
            extra_row = set(row) - set(OCCURRENCE_KEYS)
            for key in sorted(extra_row):
                if key.lower() in RATE_KEYS or RATE_KEY_RE.search(key):
                    continue
                col.hard("schema", f"{loc}.{key}", f"未知字段 {key!r}")
            if not isinstance(row.get("window"), str) or not str(row.get("window")).strip():
                col.hard("schema", f"{loc}.window", "必须是非空字符串")
            n = row.get("n")
            if type(n) is not int or isinstance(n, bool) or n < 0:
                col.hard("schema", f"{loc}.n", "必须是非负整数（不是比率）")

    if evidence.get("signal_tier") not in SIGNAL_TIERS:
        col.hard("schema", "evidence.signal_tier", "必须是 production|dogfood|L1_synthetic")
    repro = evidence.get("repro_tier")
    if repro is not None and repro not in REPRO_TIERS:
        col.hard("schema", "evidence.repro_tier", "必须是 production|dogfood|L1_synthetic|null")

    if evidence.get("signal_tier") == "production":
        has_ids = bool(traces) or bool(conversations)
        if not has_ids:
            col.hard(
                "production_ids",
                "evidence",
                "signal_tier=production 时 traces 或 conversations 必须非空",
            )

    disposition = data.get("disposition")
    if not isinstance(disposition, dict):
        col.hard("schema", "disposition", "必须是 object")
        return
    extra_d = set(disposition) - set(DISPOSITION_KEYS)
    for key in sorted(extra_d):
        if key.lower() in RATE_KEYS or RATE_KEY_RE.search(key) or key in PREVIEW_KEYS:
            continue
        col.hard("schema", f"disposition.{key}", f"未知字段 {key!r}")
    for key in DISPOSITION_KEYS:
        if key not in disposition:
            col.hard("schema", f"disposition.{key}", "缺字段")
    for key in ("eval_cases", "conformance_vectors", "dogfood_slots"):
        val = disposition.get(key)
        bad_list = not isinstance(val, list) or not all(
            isinstance(x, str) and x.strip() for x in val
        )
        if bad_list:
            col.hard("schema", f"disposition.{key}", "必须是字符串数组")
    family_entry = disposition.get("family_entry")
    if family_entry is not None and not (isinstance(family_entry, str) and family_entry.strip()):
        col.hard("schema", "disposition.family_entry", "必须是字符串或 null")
    commits = disposition.get("fix_commits")
    if not isinstance(commits, list) or not all(isinstance(x, str) for x in commits):
        col.hard("schema", "disposition.fix_commits", "必须是字符串数组")
    else:
        for i, sha in enumerate(commits):
            if not SHA_RE.match(sha):
                col.hard("schema", f"disposition.fix_commits[{i}]", "必须是 git sha")


def _check_intercept(col: _Collector, data: dict[str, Any]) -> None:
    proposal = data.get("intercept_proposal")
    if proposal is None:
        if data.get("fix_class") == "intercept" and data.get("status") == "fixed":
            col.hard(
                "intercept",
                "intercept_proposal",
                "fix_class=intercept 不许进 fixed（缺提案）",
            )
        return
    if not isinstance(proposal, dict):
        col.hard("schema", "intercept_proposal", "必须是 object 或 null")
        return
    extra = set(proposal) - set(INTERCEPT_FIELDS)
    for key in sorted(extra):
        if key.lower() in RATE_KEYS or RATE_KEY_RE.search(key) or key in PREVIEW_KEYS:
            continue
        col.hard("schema", f"intercept_proposal.{key}", f"未知字段 {key!r}")
    missing = [
        k
        for k in INTERCEPT_FIELDS
        if not (isinstance(proposal.get(k), str) and proposal[k].strip())
    ]
    if data.get("fix_class") == "intercept" and data.get("status") == "fixed" and missing:
        col.hard(
            "intercept",
            "intercept_proposal",
            "三项必填：false_positive_surface / why_ladder_insufficient / soft_net_negative",
        )
    for key in INTERCEPT_FIELDS:
        val = proposal.get(key)
        if isinstance(val, str):
            if len(val) > INTERCEPT_FIELD_MAX:
                col.hard("body", f"intercept_proposal.{key}", f"超过 {INTERCEPT_FIELD_MAX} 字")
            if WARN_RATIO_RE.search(val):
                col.warn("ratio_wording", f"intercept_proposal.{key}", "自由文含 % / 占比 / 显著")


def _check_free_text_fields(col: _Collector, data: dict[str, Any]) -> None:
    symptom = data.get("symptom")
    if not isinstance(symptom, str) or not symptom.strip():
        col.hard("schema", "symptom", "必须是非空字符串")
    elif isinstance(symptom, str):
        _check_free_text(col, "symptom", symptom, limit=SYMPTOM_MAX)

    note = data.get("verdict_note")
    if not isinstance(note, str):
        col.hard("schema", "verdict_note", "必须是字符串")
    else:
        _check_free_text(col, "verdict_note", note, limit=NOTE_MAX)

    candidate = data.get("family_candidate")
    if candidate is not None:
        if not isinstance(candidate, str):
            col.hard("schema", "family_candidate", "必须是字符串或 null")
        else:
            _check_free_text(col, "family_candidate", candidate, limit=FAMILY_CANDIDATE_MAX)

    family = data.get("family")
    if family is not None and not (isinstance(family, str) and family.strip()):
        col.hard("schema", "family", "必须是字符串或 null")


def _check_matrix(col: _Collector, data: dict[str, Any]) -> None:
    status = data.get("status")
    verdict = data.get("verdict")
    close_reason = data.get("close_reason")
    if status not in STATUSES or verdict not in VERDICTS:
        return

    if status != "closed" and close_reason is not None:
        col.hard("close_reason", "close_reason", "非 closed 时 close_reason 必须为 null")
    if status == "closed" and close_reason not in CLOSE_REASONS:
        col.hard("close_reason", "close_reason", "closed 必须填写 close_reason")

    if status == "open":
        if verdict != "undecided":
            col.hard("matrix", "verdict", "open 的唯一合法 verdict 是 undecided")
    elif status == "triaged":
        if verdict in NON_DEFECT:
            col.hard(
                "matrix",
                "verdict",
                "triaged 遇上非缺陷 verdict 须同批进 closed，不能停在 triaged",
            )
    elif status in {"reproduced", "fixed", "regressed"}:
        if verdict != "defect":
            col.hard("matrix", "verdict", f"{status} 必须 verdict=defect")
    elif status == "closed":
        if verdict == "undecided":
            col.hard("matrix", "verdict", "closed 禁止 undecided")
        elif verdict == "defect" and close_reason not in CLOSED_DEFECT_REASONS:
            col.hard(
                "matrix",
                "close_reason",
                "closed+defect 的 close_reason 必须是 resolved|abandoned|duplicate",
            )
        elif verdict in NON_DEFECT and close_reason not in CLOSED_NON_DEFECT_REASONS:
            col.hard(
                "matrix",
                "close_reason",
                "closed+非缺陷 的 close_reason 必须是 not_a_defect|wont_fix",
            )

    if close_reason == "duplicate":
        dup = data.get("duplicate_of")
        if not (isinstance(dup, str) and ID_RE.match(dup)):
            col.hard("duplicate_of", "duplicate_of", "closed(duplicate) 必须填写 duplicate_of")
    elif data.get("duplicate_of") is not None and close_reason != "duplicate":
        col.hard("duplicate_of", "duplicate_of", "仅 close_reason=duplicate 时可填 duplicate_of")


def _transition_error(
    fr_s: str,
    to_s: str,
    fr_v: str,
    to_v: str,
    *,
    note: str,
    close_reason: str | None,
    duplicate_of: Any,
    pointers: list[str],
    fix_commits: list[str],
) -> str | None:
    note_ok = bool(note.strip())
    if (fr_s, to_s) == ("open", "triaged"):
        return None
    if (fr_s, to_s) == ("open", "closed"):
        if not (isinstance(duplicate_of, str) and ID_RE.match(duplicate_of)):
            return "open→closed 只允许 closed(duplicate)，且须填 duplicate_of"
        if to_v == "undecided":
            return "closed 禁止 undecided（open→closed 须同时改 verdict）"
        return None
    if (fr_s, to_s) == ("triaged", "reproduced"):
        if to_v != "defect":
            return "triaged→reproduced 要求 verdict=defect"
        if not pointers:
            return "triaged→reproduced 要求至少一类可复跑指针非空"
        return None
    if (fr_s, to_s) == ("triaged", "closed"):
        if to_v not in NON_DEFECT:
            return "triaged→closed 要求 verdict ∈ {noise, honest_refusal, wont_fix}"
        if close_reason not in CLOSED_NON_DEFECT_REASONS and close_reason is not None:
            return "triaged→closed 的 close_reason 必须是 not_a_defect|wont_fix"
        return None
    if (fr_s, to_s) == ("reproduced", "fixed"):
        if to_v != "defect":
            return "reproduced→fixed 要求 verdict=defect"
        if not fix_commits:
            return "reproduced→fixed 要求 fix_commits 非空"
        return None
    if (fr_s, to_s) == ("reproduced", "closed"):
        if close_reason not in {"wont_fix", "not_a_defect"} and close_reason is not None:
            return "reproduced→closed 只允许 wont_fix|not_a_defect"
        if not note_ok:
            return "reproduced→closed 须 note"
        return None
    if (fr_s, to_s) == ("fixed", "closed"):
        if close_reason == "abandoned" and not note_ok:
            return "fixed→closed(abandoned) 须 note"
        if close_reason not in {"resolved", "abandoned"} and close_reason is not None:
            return "fixed→closed 只允许 resolved|abandoned"
        return None
    if (fr_s, to_s) == ("fixed", "regressed"):
        return None
    if (fr_s, to_s) == ("closed", "regressed"):
        if fr_v != "defect":
            return "closed→regressed 仅 closed(resolved)（verdict=defect）"
        return None
    if (fr_s, to_s) == ("closed", "triaged"):
        if fr_v not in NON_DEFECT or to_v != "defect":
            return "closed→triaged 仅当 verdict 从非缺陷翻成 defect"
        if not note_ok:
            return "closed→triaged 须 note"
        return None
    if (fr_s, to_s) == ("regressed", "reproduced"):
        if to_v != "defect":
            return "regressed→reproduced 要求 verdict=defect"
        return None
    return f"非法转移 {fr_s}→{to_s}"


def _check_history(col: _Collector, data: dict[str, Any]) -> None:
    history = data.get("history")
    if not isinstance(history, list):
        col.hard("schema", "history", "必须是数组")
        return

    status = data.get("status")
    verdict = data.get("verdict")
    disposition = data.get("disposition") if isinstance(data.get("disposition"), dict) else {}
    pointers = _repro_pointers(disposition) if isinstance(disposition, dict) else []
    raw_commits = disposition.get("fix_commits") if isinstance(disposition, dict) else []
    if isinstance(raw_commits, list):
        fix_commits = [x for x in raw_commits if isinstance(x, str) and x.strip()]
    else:
        fix_commits = []

    for i, row in enumerate(history):
        loc = f"history[{i}]"
        if not isinstance(row, dict):
            col.hard("schema", loc, "必须是 object")
            continue
        extra = set(row) - set(HISTORY_KEYS)
        for key in sorted(extra):
            if key.lower() in RATE_KEYS or RATE_KEY_RE.search(key) or key in PREVIEW_KEYS:
                continue
            col.hard("schema", f"{loc}.{key}", f"未知字段 {key!r}")
        at = row.get("at")
        if not isinstance(at, str) or not AT_RE.match(at):
            col.hard("schema", f"{loc}.at", "必须是 YYYY-MM-DD 或 ISO-8601 Z")
        st = row.get("status")
        vd = row.get("verdict")
        if not (isinstance(st, list) and len(st) == 2 and all(s in STATUSES for s in st)):
            col.hard("history", f"{loc}.status", "必须是 [from, to] 两个合法 status")
            continue
        if not (isinstance(vd, list) and len(vd) == 2 and all(v in VERDICTS for v in vd)):
            col.hard("history", f"{loc}.verdict", "必须是 [from, to] 两个合法 verdict")
            continue
        note = row.get("note")
        if not isinstance(note, str):
            col.hard("schema", f"{loc}.note", "必须是字符串")
            note = ""
        else:
            _check_free_text(col, f"{loc}.note", note, limit=NOTE_MAX)

        err = _transition_error(
            st[0],
            st[1],
            vd[0],
            vd[1],
            note=note,
            close_reason=(
                data.get("close_reason")
                if st[1] == "closed" or status == "closed"
                else None
            ),
            duplicate_of=data.get("duplicate_of"),
            pointers=pointers,
            fix_commits=fix_commits,
        )
        if err:
            col.hard("transition", loc, err)

    if not history:
        if status != "open" or verdict != "undecided":
            col.hard("history", "history", "空 history 只允许 status=open 且 verdict=undecided")
        return

    first = history[0]
    if isinstance(first, dict):
        st = first.get("status")
        vd = first.get("verdict")
        if isinstance(st, list) and st and st[0] != "open":
            col.hard("history", "history[0].status", "第一条转移的 from 必须是 open")
        if isinstance(vd, list) and vd and vd[0] != "undecided":
            col.hard("history", "history[0].verdict", "第一条转移的 from verdict 必须是 undecided")

    prev_s: str | None = None
    prev_v: str | None = None
    for i, row in enumerate(history):
        if not isinstance(row, dict):
            continue
        st = row.get("status")
        vd = row.get("verdict")
        if not (isinstance(st, list) and len(st) == 2 and isinstance(vd, list) and len(vd) == 2):
            continue
        if prev_s is not None and (st[0] != prev_s or vd[0] != prev_v):
            col.hard("history", f"history[{i}]", "转移链不连续（from 必须接上一步 to）")
        prev_s, prev_v = st[1], vd[1]

    if prev_s is not None and (prev_s != status or prev_v != verdict):
        col.hard("history", "history", "最后一步 to 必须等于当前 status/verdict")


def _check_disciplines(col: _Collector, data: dict[str, Any]) -> None:
    status = data.get("status")
    verdict = data.get("verdict")
    disposition = data.get("disposition") if isinstance(data.get("disposition"), dict) else {}
    evidence = data.get("evidence") if isinstance(data.get("evidence"), dict) else {}
    history = data.get("history") if isinstance(data.get("history"), list) else []

    pointers = _repro_pointers(disposition) if isinstance(disposition, dict) else []
    after_reproduced = status in {"reproduced", "fixed", "regressed"}
    if status == "closed" and data.get("close_reason") in {"resolved", "abandoned"}:
        after_reproduced = True
    if after_reproduced and not pointers:
        col.hard(
            "repro_gate",
            "disposition",
            "reproduced 及之后 eval_cases∪conformance_vectors∪dogfood_slots 至少一类非空",
        )

    if status == "regressed":
        seen_fixed = False
        seen_resolved_close = False
        for row in history:
            if not isinstance(row, dict):
                continue
            st = row.get("status")
            if not (isinstance(st, list) and len(st) == 2):
                continue
            if st[1] == "fixed" or st[0] == "fixed":
                seen_fixed = True
            if st[0] == "closed" and st[1] == "regressed":
                seen_resolved_close = True
        if not (seen_fixed or seen_resolved_close):
            col.hard(
                "regressed_id",
                "status",
                "regressed 必须落在已进入过 fixed 或 closed(resolved) 的同一 id 上",
            )

    if verdict in NON_DEFECT:
        note = data.get("verdict_note")
        if not (isinstance(note, str) and note.strip()):
            col.hard("nondefect_record", "verdict_note", "非缺陷 verdict 必须有 verdict_note")
        if not _evidence_nonempty(evidence):
            col.hard("nondefect_record", "evidence", "非缺陷 verdict 必须有非空 evidence")


def _check_similarity_warn(
    findings: list[Finding],
    cases: list[tuple[str, dict[str, Any]]],
) -> None:
    for i, (src_a, a) in enumerate(cases):
        for src_b, b in cases[i + 1 :]:
            fam_a, fam_b = a.get("family"), b.get("family")
            if not fam_a or fam_a != fam_b:
                continue
            ev_a = a.get("evidence") if isinstance(a.get("evidence"), dict) else {}
            ev_b = b.get("evidence") if isinstance(b.get("evidence"), dict) else {}
            traces_a = set(ev_a.get("traces") or [])
            traces_b = set(ev_b.get("traces") or [])
            if not traces_a.intersection(traces_b):
                continue
            slug_a = _slug_of(str(a.get("id") or ""))
            slug_b = _slug_of(str(b.get("id") or ""))
            if SequenceMatcher(None, slug_a, slug_b).ratio() < 0.6:
                continue
            findings.append(
                Finding(
                    "warn",
                    "similar_case",
                    f"{src_a}:id",
                    f"与 {src_b} 同 family、trace 重叠且 slug 相似（纪律 2 warn，不挡 PR）",
                )
            )


def lint_document(
    data: Any,
    *,
    source: str = "<case>",
    filename: str | None = None,
) -> list[Finding]:
    col = _Collector(source)
    _check_rate_and_preview_keys(col, data)
    shaped = _check_shape(col, data)
    if shaped is None:
        return col.findings
    _check_id_and_meta(col, shaped, filename=filename)
    _check_lists_and_evidence(col, shaped)
    _check_free_text_fields(col, shaped)
    _check_intercept(col, shaped)
    _check_matrix(col, shaped)
    _check_history(col, shaped)
    _check_disciplines(col, shaped)
    return col.findings


def _iter_case_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix == ".json" else []
    if not path.is_dir():
        return []
    return sorted(p for p in path.glob("*.json") if p.is_file())


def lint_path(path: Path) -> list[Finding]:
    findings: list[Finding] = []
    files = _iter_case_files(path)
    loaded: list[tuple[str, dict[str, Any]]] = []
    enforce_name = path.is_dir() and path.resolve() == CASES_DIR.resolve()
    if path.is_file():
        enforce_name = path.parent.resolve() == CASES_DIR.resolve()

    if path.is_dir() and not path.exists():
        return [Finding("hard", "schema", str(path), "目录不存在")]

    for file in files:
        try:
            raw = json.loads(file.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            findings.append(Finding("hard", "schema", str(file), f"无法解析 JSON: {exc}"))
            continue
        name = file.name if enforce_name else None
        findings.extend(lint_document(raw, source=str(file), filename=name))
        if isinstance(raw, dict):
            loaded.append((str(file), raw))

    _check_similarity_warn(findings, loaded)

    if path.is_dir() and enforce_name:
        ids = [str(c.get("id") or "") for _, c in loaded]
        for src, case in loaded:
            dup = case.get("duplicate_of")
            if isinstance(dup, str) and ID_RE.match(dup) and dup not in ids:
                findings.append(
                    Finding(
                        "hard",
                        "duplicate_of",
                        f"{src}:duplicate_of",
                        f"指向的案 {dup} 不在案册内",
                    )
                )
    return findings


def lint_tree(cases_dir: Path | None = None, *, hard_only: bool = False) -> list[Finding]:
    findings = lint_path(cases_dir or CASES_DIR)
    if hard_only:
        return [f for f in findings if f.level == "hard"]
    return findings


def _print_findings(findings: list[Finding], *, hard_only: bool) -> None:
    shown = [f for f in findings if (not hard_only) or f.level == "hard"]
    for item in shown:
        stream = sys.stderr if item.level == "hard" else sys.stdout
        print(item.format(), file=stream)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lint quality-case JSON (hard/warn).")
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="文件或目录（默认 evals/quality-cases/cases）",
    )
    parser.add_argument(
        "--hard-only",
        action="store_true",
        help="只跑 hard 档（wrapper / 门禁用）；warn 不输出也不计退出码",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    targets = args.paths or [CASES_DIR]
    findings: list[Finding] = []
    for target in targets:
        if not target.exists():
            print(f"HARD: {target}: [schema] 路径不存在", file=sys.stderr)
            return 1
        findings.extend(lint_path(target))

    hard = [f for f in findings if f.level == "hard"]
    warn = [f for f in findings if f.level == "warn"]
    _print_findings(findings, hard_only=args.hard_only)

    if hard:
        print(f"FAIL: {len(hard)} hard, {len(warn)} warn", file=sys.stderr)
        return 1
    extra = "" if args.hard_only else f", {len(warn)} warn"
    print(f"OK: {len(targets)} path(s), 0 hard{extra}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
