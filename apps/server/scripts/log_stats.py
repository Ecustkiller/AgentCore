"""Quick stats from logs/dev.jsonl — event counts, errors, turn quality metrics.

Pure JSONL reader (no DB / agentcore import needed). Run from apps/server:

    uv run python scripts/log_stats.py                  # last 7 days (default)
    uv run python scripts/log_stats.py --since 24h
    uv run python scripts/log_stats.py --all
    uv run python scripts/log_stats.py --file ../../logs/prod-export/events.jsonl

Reads the repo-root ``logs/dev.jsonl`` by default (plus rotating backups
``dev.jsonl.1`` … ``dev.jsonl.N`` when present). Use ``--file`` to analyze
another JSONL (same backup discovery applies). See .cursor/rules/conversation-logs.mdc.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

# scripts/ -> server -> apps -> <repo root>
LOG_FILE = Path(__file__).resolve().parents[3] / "logs" / "dev.jsonl"

_DEFAULT_SINCE = "7d"
_WORKER_ROW_BUDGET = 40
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I
)
_HEX32_RE = re.compile(r"^[0-9a-f]{32}", re.I)

# Error-signature placeholders: strip volatile ids so foreign exception text clusters.
_SIG_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I
)
_SIG_HEX_RE = re.compile(r"\b[0-9a-f]{16,}\b", re.I)
_SIG_ADDR_RE = re.compile(r"0x[0-9a-f]+\b", re.I)
_SIG_NUM_RE = re.compile(r"\b\d+\b")
_SIG_WS_RE = re.compile(r"\s+")


def _error_signature(raw: object) -> str:
    """Normalize an error event string for clustering (uuid/hex/addr/numbers → placeholders)."""
    text = raw if isinstance(raw, str) else str(raw if raw is not None else "?")
    s = _SIG_UUID_RE.sub("<uuid>", text)
    s = _SIG_ADDR_RE.sub("<addr>", s)
    s = _SIG_HEX_RE.sub("<hex>", s)
    s = _SIG_NUM_RE.sub("<n>", s)
    return _SIG_WS_RE.sub(" ", s).strip() or "?"


def _avg(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _parse_since(spec: str, *, now: datetime | None = None) -> datetime:
    """Parse ``24h`` / ``7d`` / ISO date-or-datetime into an aware UTC cutoff."""
    now = now or datetime.now(UTC)
    s = spec.strip()
    m = re.fullmatch(r"(\d+)\s*([hdw])", s, re.I)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        delta = {"h": timedelta(hours=n), "d": timedelta(days=n), "w": timedelta(weeks=n)}[unit]
        return now - delta
    raw = s[:-1] + "+00:00" if s.endswith("Z") else s
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError as e:
        raise SystemExit(
            f"Invalid --since {spec!r}: use 24h / 7d / 2w or an ISO date (YYYY-MM-DD[THH:MM…])"
        ) from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _parse_timestamp(raw: object) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _discover_log_files(primary: Path) -> list[Path]:
    """Primary file plus RotatingFileHandler backups, oldest → newest.

    ``name.jsonl.N`` (higher N = older) then ``name.jsonl`` (current). Explicit
    ``--file`` still discovers siblings so rotation stays transparent.
    """
    primary = primary.resolve()
    parent = primary.parent
    name = primary.name
    backups: list[tuple[int, Path]] = []
    for p in parent.glob(name + ".*"):
        suffix = p.name[len(name) + 1 :]
        if suffix.isdigit():
            backups.append((int(suffix), p))
    backups.sort(key=lambda t: t[0], reverse=True)  # .5 … .1
    files = [p for _, p in backups]
    if primary.exists():
        files.append(primary)
    return files


def _iter_jsonl_objs(files: list[Path]):
    for path in files:
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    yield None  # caller counts bad lines


# ── 协作质量 (学·度量 闸门, docs/06-规划/远期规划.md §2.4) ──
# Per-turn collaboration-quality signals, grouped by trace_id (= one user interaction,
# logging.mdc) and labeled by MAST group (Multi-Agent System Failure Taxonomy: 规格 /
# 错位 / 验证 / 终止). All four metrics are derived from events the runtime ALREADY logs
# — this is a pure read over logs/dev.jsonl, no runtime change. 单一事实源 note: the same
# four are also persisted per-turn in the turn_metrics table for the prod/operator面.
_EARLY_FINISH_FLAGS = {"length", "max_rounds", "degraded", "unproductive"}


def _new_trace() -> dict:
    return {
        "turn": False,  # saw a chat.turn_complete / chat.resume_complete for this trace
        "delegated": False,
        "finish_reason": None,
        "contract_retry": 0,
        "contract_failed": 0,
        "revise": 0,
        "revise_failed": 0,
        "delegate_batches": 0,
        "yields": 0,  # delegate.yielded boundaries (first plan needed mid-course replan)
        "scope_yields": 0,
        "escalations": 0,
        "scope_boundaries": 0,
        "scope_ratio_sum": 0.0,
        "scope_ratio_n": 0,
        "loop_nudge": 0,
        "loop_finalize": 0,
        "max_rounds": 0,
    }


def _accumulate_trace(rec: dict, event: str, obj: dict) -> None:
    """Fold one log line into its trace's collaboration-quality tally."""
    if event in ("chat.turn_complete", "chat.resume_complete"):
        rec["turn"] = True
        rec["delegated"] = rec["delegated"] or bool(obj.get("delegated"))
        rec["finish_reason"] = obj.get("finish_reason") or rec["finish_reason"]
    elif event == "contract.retry":
        rec["contract_retry"] += 1
    elif event == "contract.failed":
        rec["contract_failed"] += 1
    elif event == "revise.started" or event == "delegate.continuation_ok":
        rec["revise"] += 1
    elif event == "run.revise_failed" or event == "run.continuation_failed":
        rec["revise_failed"] += 1
    elif event == "delegate.started":
        rec["delegated"] = True
        rec["delegate_batches"] += 1
    elif event == "delegate.completed":
        rec["escalations"] += int(obj.get("escalations", 0) or 0)
        rec["scope_boundaries"] += int(obj.get("scope", 0) or 0)
        if obj.get("escalations"):
            rec["scope_ratio_sum"] += float(obj.get("scope_ratio", 0.0) or 0.0)
            rec["scope_ratio_n"] += 1
    elif event == "delegate.yielded":
        rec["yields"] += 1
        if obj.get("reason") == "scope":
            rec["scope_yields"] += 1
    elif event == "engine.loop_nudge":
        rec["loop_nudge"] += 1
    elif event == "engine.loop_finalize":
        rec["loop_finalize"] += 1
    elif event == "engine.max_rounds_exhausted":
        rec["max_rounds"] += 1


# engine convergence events → the per-trace tally field they fold into (_accumulate_trace).
_GOVERNANCE_EVENTS = {
    "engine.loop_nudge": "loop_nudge",
    "engine.loop_finalize": "loop_finalize",
    "engine.max_rounds_exhausted": "max_rounds",
}


def _print_convergence_governance(events: Counter[str], traces: dict[str, dict]) -> None:
    """Convergence signals (engine governance.py / loop.py): loops nudged / force-finalized
    / round-budget exhausted — spikes mean the AI is spinning.

    Each raw total is split in-turn vs orphan. An ``orphan`` event either carries no
    trace_id or belongs to a trace that never logged a chat.turn_complete — an eval / test
    run (these bind a trace but emit no turn), or a turn truncated out of this rolling log
    window. The turn-grouped 空转率 below counts only in-turn events, so this split is what
    reconciles it with the raw totals (previously a silent gap).
    """
    present = {e: events.get(e, 0) for e in _GOVERNANCE_EVENTS if events.get(e)}
    if not present:
        return
    completed = [t for t in traces.values() if t["turn"]]
    print("\n── Convergence Governance ──")
    for e, c in sorted(present.items(), key=lambda x: -x[1]):
        in_turn = sum(t[_GOVERNANCE_EVENTS[e]] for t in completed)
        orphan = c - in_turn
        note = f"  ({in_turn} in turns, {orphan} orphan)" if orphan else ""
        print(f"  {c:>4}x  {e}{note}")


def _print_collaboration_quality(traces: dict[str, dict]) -> None:
    """The 协作质量方向盘: four turn-level metrics + MAST group labels."""
    turns = [t for t in traces.values() if t["turn"]]
    if not turns:
        return
    n = len(turns)
    delegated = [t for t in turns if t["delegated"]]
    nd = len(delegated)

    print("\n── Collaboration Quality (协作质量 · MAST) ──")
    print(f"  Turns {n}  (delegated {nd})")

    # [验证] 返工率 — turns where someone built on a wrong assumption (MAST verification).
    rework = [
        t
        for t in turns
        if t["contract_retry"] or t["contract_failed"] or t["revise"] or t["revise_failed"]
    ]
    cr = sum(t["contract_retry"] for t in turns)
    cf = sum(t["contract_failed"] for t in turns)
    rv = sum(t["revise"] for t in turns)
    print(
        f"  [验证] 返工率       {len(rework) / n * 100:5.1f}%  "
        f"({len(rework)}/{n} turns; contract-retry {cr}, revise {rv}, contract-failed {cf})"
    )

    # [规格] 首计划存活率 + [错位] 漂移率 — both only meaningful over delegated turns.
    if nd:
        survived = [t for t in delegated if t["yields"] == 0]
        replanned = nd - len(survived)
        print(
            f"  [规格] 首计划存活率 {len(survived) / nd * 100:5.1f}%  "
            f"({len(survived)}/{nd} delegated turns ran first plan clean; "
            f"{replanned} needed mid-course replan)"
        )
        drift = [t for t in delegated if t["scope_yields"] or t["scope_boundaries"]]
        ratios = [
            t["scope_ratio_sum"] / t["scope_ratio_n"] for t in delegated if t["scope_ratio_n"]
        ]
        ratio_note = f"; avg scope_ratio {_avg(ratios):.2f}" if ratios else ""
        print(
            f"  [错位] 漂移率       {len(drift) / nd * 100:5.1f}%  "
            f"({len(drift)}/{nd} delegated turns w/ scope signal{ratio_note})"
        )
    else:
        print("  [规格] 首计划存活率    —    (no delegated turns)")
        print("  [错位] 漂移率         —    (no delegated turns)")

    # [终止] 空转·早收 — spinning / not-recognizing-done / early-stop (MAST termination).
    idle = [
        t
        for t in turns
        if t["loop_nudge"]
        or t["loop_finalize"]
        or t["max_rounds"]
        or (t["finish_reason"] or "").lower() in _EARLY_FINISH_FLAGS
    ]
    ln = sum(t["loop_nudge"] for t in turns)
    lf = sum(t["loop_finalize"] for t in turns)
    mr = sum(t["max_rounds"] for t in turns)
    flags = Counter(
        (t["finish_reason"] or "?")
        for t in turns
        if (t["finish_reason"] or "").lower() in _EARLY_FINISH_FLAGS
    )
    flag_note = f"; finish-flags {dict(flags)}" if flags else ""
    print(
        f"  [终止] 空转·早收     {len(idle) / n * 100:5.1f}%  "
        f"({len(idle)}/{n} turns; loop_nudge {ln}, loop_finalize {lf}, max_rounds {mr}{flag_note})"
    )


def _classify_worker(agent_id: str) -> tuple[str, str]:
    """Map agent_id → (agg_label, family).

    Historical ``delegate.started`` only logs ``nodes`` (int) — no run→role map.
    Run instances encode role in the id suffix (``del_<uuid>_<role>``,
    ``debate_<uuid>_<role>``), so we aggregate by family · role instead of
    listing every run instance.
    """
    if not agent_id or agent_id == "?":
        return "?", "?"
    if agent_id == "CEO":
        return "CEO", "CEO"
    for prefix, family in (("del_", "del"), ("debate_", "debate"), ("add_", "add")):
        if agent_id.startswith(prefix):
            rest = agent_id[len(prefix) :]
            m = _UUID_RE.match(rest) or _HEX32_RE.match(rest)
            if m and len(rest) > m.end() and rest[m.end()] == "_":
                return f"{family} · {rest[m.end() + 1 :]}", family
            return f"{family} · *", family
    if _UUID_RE.match(agent_id) or _HEX32_RE.match(agent_id):
        return "uuid · *", "uuid"
    return agent_id, "other"


def _short_agent(agent_id: str, width: int = 28) -> str:
    if len(agent_id) <= width:
        return agent_id
    return agent_id[: width - 1] + "…"


def _print_by_worker(tool_calls: list[dict]) -> None:
    """Aggregate By worker to ≤40 rows: family·role + top anomalous instances."""
    by_agent: dict[str, list[dict]] = defaultdict(list)
    for t in tool_calls:
        by_agent[t.get("agent_id") or "?"].append(t)
    if len(by_agent) <= 1:
        return

    by_label: dict[str, list[dict]] = defaultdict(list)
    agents_per_label: dict[str, set[str]] = defaultdict(set)
    family_of: dict[str, str] = {}
    for agent_id, calls in by_agent.items():
        label, family = _classify_worker(agent_id)
        by_label[label].extend(calls)
        agents_per_label[label].add(agent_id)
        family_of[label] = family

    def _row_stats(calls: list[dict]) -> tuple[float, float, str, str]:
        errs = sum(1 for t in calls if t.get("status") not in ("ok", None))
        durs = [t["duration_ms"] for t in calls if t.get("duration_ms")]
        ok_pct = (len(calls) - errs) / len(calls) * 100 if calls else 100.0
        avg_dur = _avg(durs) if durs else 0.0
        depth = next((t.get("depth") for t in calls if t.get("depth") is not None), None)
        meta = f"d{depth}" if depth is not None else "—"
        dur = f"avg {_avg(durs):.0f}ms" if durs else "—"
        top = ", ".join(
            f"{n}×{cnt}" for n, cnt in Counter(t.get("tool", "?") for t in calls).most_common(4)
        )
        return ok_pct, avg_dur, meta, f"{dur:<11} {top}"

    all_durs = [t["duration_ms"] for t in tool_calls if t.get("duration_ms")]
    overall_avg = _avg(all_durs) if all_durs else 0.0

    ranked = sorted(by_label.items(), key=lambda kv: -len(kv[1]))

    # Reserve: 1 families summary + 1 collapse note + up to 4 outlier rows (+ header).
    role_budget = max(8, _WORKER_ROW_BUDGET - 8)
    volume_take = max(6, role_budget - 6)
    selected: list[tuple[str, list[dict]]] = list(ranked[:volume_take])
    selected_labels: set[str] = {lab for lab, _ in selected}

    # Fill remaining role slots with slow / high-fail buckets missed by volume cut.
    for label, calls in ranked[volume_take:]:
        if len(selected) >= role_budget:
            break
        ok_pct, avg_dur, _, _ = _row_stats(calls)
        if ok_pct < 95.0 or (overall_avg and avg_dur > 2 * overall_avg):
            selected.append((label, calls))
            selected_labels.add(label)
    selected.sort(key=lambda kv: -len(kv[1]))

    print("\n  By worker (family · role aggregates):")
    lines_used = 0
    fam_counts = Counter(family_of[lab] for lab, _ in by_label.items())
    fam_calls = Counter()
    for lab, calls in by_label.items():
        fam_calls[family_of[lab]] += len(calls)
    fam_note = "  ".join(
        f"{f} {fam_calls[f]}calls/{fam_counts[f]}roles"
        for f in ("CEO", "del", "debate", "add", "uuid", "other", "?")
        if fam_calls.get(f)
    )
    print(f"    families: {fam_note}")
    lines_used += 1

    printed_labels: set[str] = set()
    for label, calls in selected:
        if lines_used >= _WORKER_ROW_BUDGET - 2:
            break
        ok_pct, _, meta, rest = _row_stats(calls)
        n_runs = len(agents_per_label[label])
        runs_note = f"  ({n_runs} runs)" if n_runs > 1 else ""
        print(
            f"    {label:<28} {meta:<3} {len(calls):>4} calls  "
            f"{ok_pct:5.1f}% ok  {rest}{runs_note}"
        )
        lines_used += 1
        printed_labels.add(label)

    hidden = [(lab, calls) for lab, calls in ranked if lab not in printed_labels]
    if hidden and lines_used < _WORKER_ROW_BUDGET:
        hid_calls = sum(len(c) for _, c in hidden)
        print(f"    … +{len(hidden)} more roles ({hid_calls} calls)")
        lines_used += 1

    # Top anomalous *instances* inside run families (still ≤ budget).
    outliers: list[tuple[float, str, list[dict]]] = []
    for agent_id, calls in by_agent.items():
        _, family = _classify_worker(agent_id)
        if family not in ("del", "debate", "add", "uuid"):
            continue
        if len(calls) < 5:
            continue
        ok_pct, avg_dur, _, _ = _row_stats(calls)
        score = 0.0
        if ok_pct < 90.0:
            score += (90.0 - ok_pct) * 10 + len(calls)
        if overall_avg and avg_dur > 2.5 * overall_avg:
            score += (avg_dur / overall_avg) * 5 + len(calls) * 0.1
        if score > 0:
            outliers.append((score, agent_id, calls))
    outliers.sort(key=lambda x: -x[0])
    if outliers and lines_used < _WORKER_ROW_BUDGET - 1:
        print("  Top outlier instances:")
        lines_used += 1
        for _, agent_id, calls in outliers:
            if lines_used >= _WORKER_ROW_BUDGET:
                break
            ok_pct, _, meta, rest = _row_stats(calls)
            print(
                f"    {_short_agent(agent_id):<28} {meta:<3} {len(calls):>4} calls  "
                f"{ok_pct:5.1f}% ok  {rest}"
            )
            lines_used += 1


def _parse_cli(argv: list[str]) -> tuple[Path, datetime | None, str | None, bool]:
    """Return (log_file, since_cutoff | None, window_label, include_synthetic).

    ``window_label`` is a short header tag: ``last 7d`` / ``--since 24h`` / ``--all``.
    """
    log_file = LOG_FILE
    since_spec: str | None = _DEFAULT_SINCE
    window_label = f"last {_DEFAULT_SINCE}"
    include_synthetic = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--file" and i + 1 < len(argv):
            log_file = Path(argv[i + 1])
            i += 2
        elif arg == "--since" and i + 1 < len(argv):
            since_spec = argv[i + 1]
            window_label = f"--since {since_spec}"
            i += 2
        elif arg == "--all":
            since_spec = None
            window_label = "--all"
            i += 1
        elif arg == "--include-synthetic":
            include_synthetic = True
            i += 1
        elif arg in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        else:
            print(f"Unknown argument: {arg}", file=sys.stderr)
            raise SystemExit(2)
    cutoff = _parse_since(since_spec) if since_spec else None
    return log_file, cutoff, window_label, include_synthetic


def main() -> None:
    log_file, since_cutoff, window_label, include_synthetic = _parse_cli(sys.argv[1:])
    files = _discover_log_files(log_file)
    if not files:
        print(f"Log file not found: {log_file}")
        print("Set LOG_FILE=logs/dev.jsonl in apps/server/.env and run a turn first.")
        sys.exit(1)

    events: Counter[str] = Counter()
    errors: list[dict] = []
    turn_completes: list[dict] = []
    tool_calls: list[dict] = []
    round_ends: list[dict] = []
    llm_calls: list[dict] = []
    cost_records: list[dict] = []
    traces: dict[str, dict] = {}
    total = 0
    bad_lines = 0
    excluded_synthetic = 0
    synthetic_by_kind: Counter[str] = Counter()

    for obj in _iter_jsonl_objs(files):
        if obj is None:
            bad_lines += 1
            continue
        if since_cutoff is not None:
            ts = _parse_timestamp(obj.get("timestamp"))
            if ts is None or ts < since_cutoff:
                continue
        traffic = obj.get("traffic")
        if traffic is not None and not include_synthetic:
            excluded_synthetic += 1
            synthetic_by_kind[str(traffic)] += 1
            continue
        total += 1
        event = obj.get("event", "")
        events[event] += 1
        tid = obj.get("trace_id")
        if tid:
            _accumulate_trace(traces.setdefault(tid, _new_trace()), event, obj)
        if obj.get("level") == "error":
            errors.append(obj)
        if event == "chat.turn_complete":
            turn_completes.append(obj)
        elif event == "tool.execute_end":
            tool_calls.append(obj)
        elif event == "react.round_end":
            round_ends.append(obj)
        elif event == "llm.call":
            llm_calls.append(obj)
        elif event == "cost.recorded":
            cost_records.append(obj)

    print(f"\n{'=' * 60}")
    print(f"  Log Stats  |  {total:,} events  |  {bad_lines} bad lines")
    if since_cutoff is not None:
        print(
            f"  Window: since {since_cutoff.strftime('%Y-%m-%dT%H:%M:%SZ')}  ({window_label})"
        )
    else:
        print(f"  Window: all time  ({window_label})")
    if len(files) > 1:
        print(f"  Files: {files[-1].name} + {len(files) - 1} rotation backup(s)")
    else:
        print(f"  File: {files[0] if files else log_file}")
    if excluded_synthetic:
        parts = " / ".join(f"{k} {synthetic_by_kind[k]}" for k in sorted(synthetic_by_kind))
        print(f"  excluded {excluded_synthetic} synthetic lines ({parts})")
    elif not include_synthetic:
        print("  excluded 0 synthetic lines (eval / test)")
    print(f"{'=' * 60}\n")

    if total == 0:
        print("  (no events in window)")
        print()
        return

    print("── Event Distribution (top 25) ──")
    for event, count in events.most_common(25):
        pct = count / total * 100 if total else 0
        bar = "█" * int(pct / 2)
        print(f"  {count:>6}  {pct:5.1f}%  {bar:<25} {event}")

    if errors:
        print(f"\n── Errors ({len(errors)} total) ──")
        # Cluster by normalized signature so foreign exception text with volatile
        # ids (uuid / hex / numbers / 0xaddr) collapses into one bucket + sample.
        clusters: dict[str, dict[str, object]] = {}
        for e in errors:
            raw = e.get("event", "?")
            sig = _error_signature(raw)
            bucket = clusters.get(sig)
            if bucket is None:
                sample = raw if isinstance(raw, str) else str(raw if raw is not None else "?")
                clusters[sig] = {"count": 1, "sample": sample}
            else:
                bucket["count"] = int(bucket["count"]) + 1
        for sig, info in sorted(clusters.items(), key=lambda kv: -int(kv[1]["count"]))[:15]:
            count = int(info["count"])
            sample = str(info["sample"])
            display = sig if len(sig) <= 100 else sig[:97] + "…"
            print(f"  {count:>4}x  {display}")
            if sample != sig:
                sample_flat = _SIG_WS_RE.sub(" ", sample).strip()
                if len(sample_flat) > 120:
                    sample_flat = sample_flat[:117] + "…"
                print(f"         e.g. {sample_flat}")

    if turn_completes:
        print(f"\n── Turns (chat.turn_complete: {len(turn_completes)}) ──")
        durations = [t["duration_ms"] for t in turn_completes if t.get("duration_ms")]
        rounds = [t["rounds"] for t in turn_completes if t.get("rounds")]
        in_tok = [t.get("input_tokens", 0) for t in turn_completes]
        out_tok = [t.get("output_tokens", 0) for t in turn_completes]
        delegated = sum(1 for t in turn_completes if t.get("delegated"))
        if durations:
            print(
                f"  Duration   avg={_avg(durations):.0f}ms  min={min(durations)}  max={max(durations)}"
            )
        if rounds:
            print(f"  Rounds     avg={_avg(rounds):.1f}  min={min(rounds)}  max={max(rounds)}")
        print(f"  Tokens     in avg={_avg(in_tok):.0f}  out avg={_avg(out_tok):.0f}")
        print(f"  Delegated  {delegated}/{len(turn_completes)} turns spun up a team")

    if round_ends:
        print(f"\n── ReAct Rounds (react.round_end: {len(round_ends)}) ──")
        tools_per = [r.get("tools", 0) for r in round_ends]
        rtok = [r.get("reasoning_tokens", 0) for r in round_ends]
        otok = [r.get("output_tokens", 0) for r in round_ends]
        spinning = sum(1 for n in tools_per if n >= 3)
        print(
            f"  Tools/round    avg={_avg(tools_per):.1f}  max={max(tools_per)}  ({spinning} rounds ≥3 tools)"
        )
        print(
            f"  Reasoning tok  avg={_avg(rtok):.0f}/round   Output tok avg={_avg(otok):.0f}/round"
        )

    if llm_calls:
        print(f"\n── LLM Calls (llm.call: {len(llm_calls)}) ──")
        timed = [c for c in llm_calls if c.get("latency_ms")]
        stubbed = len(llm_calls) - len(timed)
        lat = [c["latency_ms"] for c in timed]
        in_tok = [c.get("input_tokens", 0) for c in llm_calls]
        out_tok = [c.get("output_tokens", 0) for c in llm_calls]
        rea_tok = [c.get("reasoning_tokens", 0) for c in llm_calls]
        in_sum = sum(in_tok)
        hit_sum = sum(c.get("cache_hit_tokens", 0) for c in llm_calls)
        if lat:
            print(f"  Latency    avg={_avg(lat):.0f}ms  max={max(lat)}ms")
        print(
            f"  Tokens     in avg={_avg(in_tok):.0f}  out avg={_avg(out_tok):.0f}"
            f"  reasoning avg={_avg(rea_tok):.0f}"
        )
        if in_sum:
            print(f"  Cache      {hit_sum / in_sum * 100:.1f}% of input tokens hit cache")
        # finish_reason mix — `length`/`content_filter` are quality red flags
        # (truncated / filtered answers), worth surfacing even at low counts.
        fr = Counter(c.get("finish_reason", "?") for c in llm_calls)
        print(f"  Finish     {'  '.join(f'{k}×{v}' for k, v in fr.most_common())}")
        if stubbed:
            print(
                f"  (excluded {stubbed} llm.call without latency_ms from By scenario · model — likely test stubs)"
            )
        # By scenario · model: only calls with real latency (skip test stubs).
        by_sm: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for c in timed:
            by_sm[(c.get("scenario", "?"), c.get("model", "?"))].append(c)
        if by_sm:
            print("  By scenario · model:")
            for (scenario, model), calls in sorted(by_sm.items(), key=lambda kv: -len(kv[1])):
                c_lat = [x["latency_ms"] for x in calls]
                dur = f"avg {_avg(c_lat):.0f}ms"
                c_in = _avg([x.get("input_tokens", 0) for x in calls])
                c_out = _avg([x.get("output_tokens", 0) for x in calls])
                label = f"{scenario} · {model}"
                print(
                    f"    {label:<34} {len(calls):>3} calls  {dur:<11} in {c_in:.0f} out {c_out:.0f}"
                )
        # Spend from per-call cost_nano (absent on pre-upgrade historical lines).
        priced = [c for c in llm_calls if "cost_nano" in c]
        print(f"  Cost       {len(priced)}/{len(llm_calls)} calls carry cost")
        if priced:
            by_spend: dict[tuple[str, str], list[dict]] = defaultdict(list)
            for c in priced:
                by_spend[(c.get("scenario", "?"), c.get("model", "?"))].append(c)
            total_nano = sum(int(c.get("cost_nano") or 0) for c in priced)
            print(f"  Spend      ${total_nano / 1e9:.6f}  ({total_nano:,} nano-USD)")
            print("  By scenario · model spend:")
            for (scenario, model), calls in sorted(
                by_spend.items(),
                key=lambda kv: -sum(int(x.get("cost_nano") or 0) for x in kv[1]),
            ):
                nano = sum(int(x.get("cost_nano") or 0) for x in calls)
                label = f"{scenario} · {model}"
                print(
                    f"    {label:<34} {len(calls):>3} calls  ${nano / 1e9:.6f}"
                    f"  ({nano:,} nano)"
                )

    if tool_calls:
        print(f"\n── Tool Calls ({len(tool_calls)} total) ──")
        names = Counter(t.get("tool", "?") for t in tool_calls)
        # Any terminal status other than "ok" is a failed call (error / not_found /
        # denied) — denials and bad tool names are real quality signals, not just raises.
        errs = sum(1 for t in tool_calls if t.get("status") not in ("ok", None))
        durs = [t["duration_ms"] for t in tool_calls if t.get("duration_ms")]
        print(
            f"  Success rate: {(len(tool_calls) - errs) / len(tool_calls) * 100:.1f}%  ({errs} failed)"
        )
        if durs:
            print(f"  Duration   avg={_avg(durs):.0f}ms  max={max(durs)}ms")
        for name, c in names.most_common(15):
            ne = sum(
                1
                for t in tool_calls
                if t.get("tool") == name and t.get("status") not in ("ok", None)
            )
            print(f"    {c:>4}x  {name}{f'  ({ne} err)' if ne else ''}")

        _print_by_worker(tool_calls)

    if cost_records:
        print(f"\n── Cost (cost.recorded: {len(cost_records)} turns) ──")
        # Money is integer nano-USD (the storage unit); show the raw total + a
        # rounded USD view. Per-turn avg is the headline "what does a turn cost".
        total_nano = sum(int(c.get("total_nano", 0) or 0) for c in cost_records)
        total_usd = total_nano / 1e9
        print(f"  Total      ${total_usd:.6f}  ({total_nano:,} nano-USD)")
        print(f"  Per turn   avg ${total_usd / len(cost_records):.6f}")
        model_mix: Counter[str] = Counter()
        for c in cost_records:
            for m in c.get("models") or []:
                model_mix[m] += 1
        if model_mix:
            print(f"  Models     {'  '.join(f'{m}×{n}' for m, n in model_mix.most_common())}")

    _print_convergence_governance(events, traces)
    _print_collaboration_quality(traces)

    print()


if __name__ == "__main__":
    main()
