"""Quick stats from logs/dev.jsonl — event counts, errors, turn quality metrics.

Pure JSONL reader (no DB / agentcore import needed). Run from apps/server:

    uv run python scripts/log_stats.py

Reads the repo-root ``logs/dev.jsonl`` (set LOG_FILE=logs/dev.jsonl in .env so the
server writes it). See .cursor/rules/conversation-logs.mdc.
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

# scripts/ -> server -> apps -> <repo root>
LOG_FILE = Path(__file__).resolve().parents[3] / "logs" / "dev.jsonl"


def _avg(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def main() -> None:
    if not LOG_FILE.exists():
        print(f"Log file not found: {LOG_FILE}")
        print("Set LOG_FILE=logs/dev.jsonl in apps/server/.env and run a turn first.")
        sys.exit(1)

    events: Counter[str] = Counter()
    errors: list[dict] = []
    turn_completes: list[dict] = []
    tool_calls: list[dict] = []
    round_ends: list[dict] = []
    llm_calls: list[dict] = []
    cost_records: list[dict] = []
    total = 0
    bad_lines = 0

    with open(LOG_FILE, encoding="utf-8") as f:
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
    print(f"  File: {LOG_FILE}")
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

    # Convergence governance signals (engine.py): loops nudged / force-finalized /
    # round-budget exhausted — spikes here mean the AI is spinning.
    governance = {
        e: events.get(e, 0)
        for e in ("engine.loop_nudge", "engine.loop_finalize", "engine.max_rounds_exhausted")
        if events.get(e)
    }
    if governance:
        print("\n── Convergence Governance ──")
        for e, c in sorted(governance.items(), key=lambda x: -x[1]):
            print(f"  {c:>4}x  {e}")

    print()


if __name__ == "__main__":
    main()
