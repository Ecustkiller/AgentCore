"""Quick stats from logs/dev.jsonl — event counts, errors, turn quality metrics.

Pure JSONL reader (no DB / agentcore import needed). Run from apps/server:

    uv run python scripts/log_stats.py
    uv run python scripts/log_stats.py --file ../../logs/prod-export/events.jsonl

Reads the repo-root ``logs/dev.jsonl`` by default (set LOG_FILE=logs/dev.jsonl in
.env so the server writes it). Use ``--file`` to analyze another JSONL log file.
See .cursor/rules/conversation-logs.mdc.
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

# scripts/ -> server -> apps -> <repo root>
LOG_FILE = Path(__file__).resolve().parents[3] / "logs" / "dev.jsonl"


def _avg(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


# ── 协作质量 (学·度量 闸门, docs/07-规划/远期规划.md §2.4) ──
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
    elif event == "revise.started":
        rec["revise"] += 1
    elif event == "run.revise_failed":
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


def main() -> None:
    log_file = LOG_FILE
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--file" and i + 1 < len(args):
            log_file = Path(args[i + 1])
            i += 2
        else:
            i += 1

    if not log_file.exists():
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

    with open(log_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                bad_lines += 1
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
    print(f"  File: {log_file}")
    print(f"{'=' * 60}\n")

    print("── Event Distribution (top 25) ──")
    for event, count in events.most_common(25):
        pct = count / total * 100 if total else 0
        bar = "█" * int(pct / 2)
        print(f"  {count:>6}  {pct:5.1f}%  {bar:<25} {event}")

    if errors:
        print(f"\n── Errors ({len(errors)} total) ──")
        for ev, c in Counter(e.get("event", "?") for e in errors).most_common(10):
            print(f"  {c:>4}x  {ev}")

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
        lat = [c["latency_ms"] for c in llm_calls if c.get("latency_ms")]
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
        # By scenario · model: which scenario (chat / agent.* / memory / title) on
        # which model is slow / token-heavy — the per-call attribution turns/rounds
        # can't give (a turn aggregates many calls across models).
        by_sm: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for c in llm_calls:
            by_sm[(c.get("scenario", "?"), c.get("model", "?"))].append(c)
        print("  By scenario · model:")
        for (scenario, model), calls in sorted(by_sm.items(), key=lambda kv: -len(kv[1])):
            c_lat = [x["latency_ms"] for x in calls if x.get("latency_ms")]
            dur = f"avg {_avg(c_lat):.0f}ms" if c_lat else "—"
            c_in = _avg([x.get("input_tokens", 0) for x in calls])
            c_out = _avg([x.get("output_tokens", 0) for x in calls])
            label = f"{scenario} · {model}"
            print(f"    {label:<34} {len(calls):>3} calls  {dur:<11} in {c_in:.0f} out {c_out:.0f}")

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

        # Per-worker split: agent_id/run_id/depth ride on every worker's logs (bound
        # via the executor's log_context), so tool calls attribute cleanly to who made
        # them — CEO vs each delegated worker (depth 1) vs sub-workers (depth 2). Lets
        # you spot one worker that's slow / failing / over-calling tools.
        by_agent: dict[str, list[dict]] = defaultdict(list)
        for t in tool_calls:
            by_agent[t.get("agent_id") or "?"].append(t)
        if len(by_agent) > 1:
            print("\n  By worker (agent_id · depth):")
            for agent_id, calls in sorted(by_agent.items(), key=lambda kv: -len(kv[1])):
                a_errs = sum(1 for t in calls if t.get("status") not in ("ok", None))
                a_durs = [t["duration_ms"] for t in calls if t.get("duration_ms")]
                depth = next((t.get("depth") for t in calls if t.get("depth") is not None), None)
                ok_pct = (len(calls) - a_errs) / len(calls) * 100
                label = agent_id if len(agent_id) <= 16 else agent_id[:14] + "…"
                meta = f"d{depth}" if depth is not None else "—"
                dur = f"avg {_avg(a_durs):.0f}ms" if a_durs else "—"
                top = ", ".join(
                    f"{n}×{cnt}"
                    for n, cnt in Counter(t.get("tool", "?") for t in calls).most_common(4)
                )
                print(
                    f"    {label:<16} {meta:<3} {len(calls):>3} calls  {ok_pct:5.1f}% ok  {dur:<11} {top}"
                )

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
