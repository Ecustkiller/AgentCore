"""线上巡检① — 全量 CID 清单 + 失败榜（带 trace/cid 反查）+ 跨窗快照 diff。

对应 `logs/reviews/README.md`「双轴巡检 · 轴 1 失败榜」。以前每轮巡检复制一份一次性脚本，
这里是其中稳定的部分；本窗特有的分析（如按某次部署切 pre/post）仍归临时脚本。

Thin CLI over ``agentcore.observability.query.patrol``. Run from apps/server:

    uv run python scripts/log_patrol.py --export-dir ../../logs/prod-export --since 2d
    uv run python scripts/log_patrol.py --since 24h                     # 本地 dev.jsonl
    uv run python scripts/log_patrol.py --export-dir … --json           # 结构化（Cursor AI）
    uv run python scripts/log_patrol.py --export-dir … --snapshot-out ../../logs/reviews/snapshots/w.json
    uv run python scripts/log_patrol.py --export-dir … --baseline ../../logs/reviews/snapshots/prev.json
    uv run python scripts/log_patrol.py --diff prev.json curr.json      # 离线复算，不重扫
    uv run python scripts/log_patrol.py --families                      # 只看家族表与口径指纹

纯只读：不进 ``release:gate``、不挡 PR、不碰产品运行路径、不做任何拦截或自动开案。
快照落 ``logs/`` 下（gitignore），不入仓。默认排除合成流量 ``traffic=eval|test``。
见 .cursor/rules/conversation-logs.mdc。
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# scripts/ -> server (agentcore importable)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentcore.observability.query.failure_families import (  # noqa: E402
    FAILURE_FAMILIES,
    UNKNOWN_FAMILY,
    registry_digest,
)
from agentcore.observability.query.jsonl import discover_log_files  # noqa: E402
from agentcore.observability.query.patrol import (  # noqa: E402
    DEFAULT_CLUSTER_LIMIT,
    DEFAULT_MAX_IDS,
    MUST_REVIEW_FAMILIES,
    PatrolSnapshot,
    diff_snapshots,
    load_snapshot,
    scan_patrol,
    write_snapshot,
)
from agentcore.observability.query.timeutil import parse_since, parse_timestamp  # noqa: E402

# scripts/ -> server -> apps -> <repo root>
_REPO_ROOT = Path(__file__).resolve().parents[3]
LOG_FILE = _REPO_ROOT / "logs" / "dev.jsonl"
SNAPSHOT_DIR = _REPO_ROOT / "logs" / "reviews" / "snapshots"

_DEFAULT_SINCE = "2d"
_DEFAULT_TOP = 40


class _Options:
    def __init__(self) -> None:
        self.log_file: Path | None = None
        self.export_dir: Path | None = None
        self.since_spec: str | None = _DEFAULT_SINCE
        self.until_spec: str | None = None
        self.window_label: str = f"--since {_DEFAULT_SINCE}"
        self.include_synthetic = False
        self.as_json = False
        self.max_ids = DEFAULT_MAX_IDS
        self.cluster_limit = DEFAULT_CLUSTER_LIMIT
        self.top = _DEFAULT_TOP
        self.snapshot_out: Path | None = None
        self.baseline: Path | None = None
        self.diff_pair: tuple[Path, Path] | None = None
        self.show_families = False


def _parse_cli(argv: list[str]) -> _Options:
    opts = _Options()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--file" and i + 1 < len(argv):
            opts.log_file = Path(argv[i + 1])
            i += 2
        elif arg == "--export-dir" and i + 1 < len(argv):
            opts.export_dir = Path(argv[i + 1])
            i += 2
        elif arg == "--since" and i + 1 < len(argv):
            opts.since_spec = argv[i + 1]
            opts.window_label = f"--since {argv[i + 1]}"
            i += 2
        elif arg == "--until" and i + 1 < len(argv):
            opts.until_spec = argv[i + 1]
            i += 2
        elif arg == "--all":
            opts.since_spec = None
            opts.window_label = "--all"
            i += 1
        elif arg == "--label" and i + 1 < len(argv):
            opts.window_label = argv[i + 1]
            i += 2
        elif arg == "--include-synthetic":
            opts.include_synthetic = True
            i += 1
        elif arg == "--json":
            opts.as_json = True
            i += 1
        elif arg == "--max-ids" and i + 1 < len(argv):
            opts.max_ids = int(argv[i + 1])
            i += 2
        elif arg == "--clusters" and i + 1 < len(argv):
            opts.cluster_limit = int(argv[i + 1])
            i += 2
        elif arg == "--top" and i + 1 < len(argv):
            opts.top = int(argv[i + 1])
            i += 2
        elif arg == "--snapshot-out" and i + 1 < len(argv):
            opts.snapshot_out = Path(argv[i + 1])
            i += 2
        elif arg == "--snapshot":
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%MZ")
            opts.snapshot_out = SNAPSHOT_DIR / f"patrol-{stamp}.json"
            i += 1
        elif arg == "--baseline" and i + 1 < len(argv):
            opts.baseline = Path(argv[i + 1])
            i += 2
        elif arg == "--diff" and i + 2 < len(argv):
            opts.diff_pair = (Path(argv[i + 1]), Path(argv[i + 2]))
            i += 3
        elif arg == "--families":
            opts.show_families = True
            i += 1
        elif arg in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        else:
            print(f"Unknown argument: {arg}", file=sys.stderr)
            raise SystemExit(2)
    return opts


def _resolve_log_file(opts: _Options) -> Path:
    if opts.log_file is not None:
        return opts.log_file
    if opts.export_dir is not None:
        return opts.export_dir / "events.jsonl"
    return LOG_FILE


def _short(value: str, n: int = 8) -> str:
    return (value or "")[:n]


def _ids_note(bag: dict[str, Any], n: int = 4) -> str:
    ids = bag.get("ids") or []
    total = int(bag.get("total") or 0)
    if not total:
        return "—"
    head = " ".join(_short(str(x)) for x in ids[:n])
    more = f" +{total - min(len(ids), n)}" if total > min(len(ids), n) else ""
    return f"{total} [{head}{more}]"


def _print_families_table() -> None:
    print(f"\n── 失败家族表 (registry {registry_digest()}) ──")
    print("  家族表是可累积的巡检知识资产：key 永不改名（旧名进 aliases），")
    print("  digest 变了跨窗 diff 会把该家族标 redefined、counts 判为不可比。")
    for fam in FAILURE_FAMILIES:
        must = "必审" if fam.key in MUST_REVIEW_FAMILIES else "   "
        alias = f"  ←{','.join(fam.aliases)}" if fam.aliases else ""
        print(
            f"  {fam.digest()}  r{fam.revision}  {must}  {fam.key:<22} {fam.label}"
            f"  (since {fam.since or '?'}){alias}"
        )
        if fam.note:
            print(f"                             ↳ {fam.note}")
    print(f"\n  伪家族 {UNKNOWN_FAMILY}：level=error 却没被任何家族认领 → README「新文案必审」。")


def _print_snapshot(snapshot: PatrolSnapshot, *, top: int) -> None:
    data = snapshot.to_json_dict()
    totals = data["totals"]

    print(f"\n{'=' * 72}")
    print(
        f"  巡检① 失败榜  |  {snapshot.events_scanned:,} events scanned"
        f"  |  {totals['failure_events']:,} failure hits"
    )
    print(f"  Window: {snapshot.window_label}")
    print(
        f"          since={snapshot.since or 'all'}  until={snapshot.until or '—'}"
        f"  data {snapshot.first_event_at or '?'} → {snapshot.last_event_at or '?'}"
    )
    src = f"{snapshot.export_dir}" if snapshot.export_dir else f"{len(snapshot.files)} file(s)"
    print(f"  Source: {snapshot.source_kind}  {src}  ({len(snapshot.files)} jsonl)")
    if snapshot.bad_lines or snapshot.excluded_synthetic:
        print(
            f"          {snapshot.bad_lines} bad lines,"
            f" {snapshot.excluded_synthetic} synthetic excluded"
        )
    if not snapshot.messages_available:
        print("          ⚠ 无消息正文（非 export 模式）：CID 清单只反映日志事件，非空判定不可得")
    print(f"  Registry: {registry_digest()}  ({len(FAILURE_FAMILIES)} families)")
    print(f"{'=' * 72}")

    print(f"\n── 失败家族榜 ({len(snapshot.families)} 命中) ──")
    if not snapshot.families:
        print("  (窗内无失败命中)")
    else:
        print(f"  {'次数':>6}  {'家族':<22} {'会话':<22} {'trace':<22} 样本")
        rows = sorted(snapshot.families.values(), key=lambda r: -r.events)
        for row in rows:
            j = row.to_json()
            must = "!" if row.key in MUST_REVIEW_FAMILIES else " "
            print(
                f"  {row.events:>6}{must} {row.key:<22} "
                f"{_ids_note(j['conversations'], 2):<22} {_ids_note(j['traces'], 2):<22} "
                f"{row.sample[:60]}"
            )

    print(f"\n── 高频精确文案 (top {len(snapshot.clusters)}) ──")
    if not snapshot.clusters:
        print("  (无)")
    for cluster in snapshot.clusters:
        j = cluster.to_json()
        events = " ".join(f"{k}×{v}" for k, v in cluster.events.most_common(2))
        print(f"  {cluster.count:>5}x  [{cluster.family}]  {cluster.sample[:88]}")
        print(f"         {events}")
        print(f"         cid {_ids_note(j['conversations'])}   trace {_ids_note(j['traces'])}")

    must_rows = [c for c in snapshot.conversations if c.must_review]
    print(f"\n── 必审会话 ({len(must_rows)}) ──")
    if not must_rows:
        print("  (无必审家族命中)")
    for row in must_rows[:top]:
        fams = " ".join(f"{k}×{v}" for k, v in row.families.most_common(4))
        print(
            f"  {_short(row.conversation_id)}  u{row.user_messages}/a{row.assistant_messages}"
            f"  fail={row.failure_events}  {fams}"
        )
        if row.title or row.last_user_preview:
            print(f"            「{row.title or row.last_user_preview}」")
    if len(must_rows) > top:
        print(f"  … +{len(must_rows) - top} more (use --json)")

    nonempty = [c for c in snapshot.conversations if c.nonempty]
    print(
        f"\n── CID 全量清单 (窗内 {totals['conversations']}，"
        f"非空 {totals['nonempty_conversations']}) ──"
    )
    listing = nonempty if snapshot.messages_available else snapshot.conversations
    for row in listing[:top]:
        flag = "必审" if row.must_review else ("失败" if row.failure_events else "  ")
        print(
            f"  {flag}  {_short(row.conversation_id)}  "
            f"u{row.user_messages}/a{row.assistant_messages}  ev{row.log_events}"
            f"  {row.last_activity or '?'}  {(row.title or row.first_user_preview)[:40]}"
        )
    if len(listing) > top:
        print(f"  … +{len(listing) - top} more (use --json for the full inventory)")
    print()


def _print_diff(diff: dict[str, Any]) -> None:
    base = diff["baseline"]
    curr = diff["current"]
    print(f"\n{'=' * 72}")
    print("  跨窗 diff（核验判定可复算）")
    print(f"  上窗 {base.get('label') or '?'}  {base.get('since')} → {base.get('last_event_at')}")
    print(f"  本窗 {curr.get('label') or '?'}  {curr.get('since')} → {curr.get('last_event_at')}")
    if diff["registry_changed"]:
        print(
            f"  ⚠ 家族表已变（{base.get('registry_digest')} → {curr.get('registry_digest')}）："
            "下方 redefined / new / retired 行的数量不可比"
        )
    print(f"{'=' * 72}")

    print(f"\n  {'家族':<24} {'上窗':>7} {'本窗':>7} {'Δ':>7}  状态")
    order = {"redefined": 0, "new": 1, "retired": 2, "unknown_key": 3, "stable": 4, "residual": 5}
    for row in sorted(
        diff["families"],
        key=lambda r: (order.get(r["status"], 9), -abs(r.get("delta") or 0), r["key"]),
    ):
        prev = "—" if row["prev"] is None else str(row["prev"])
        cur = "—" if row["curr"] is None else str(row["curr"])
        delta = "n/a" if row["delta"] is None else f"{row['delta']:+d}"
        note = ""
        if row.get("matched_via"):
            note = f"  ←{row['matched_via']}"
        if row["status"] == "redefined":
            note += f"  {row.get('prev_digest')}→{row.get('curr_digest')}"
        if row["status"] == "stable" and row["delta"] == 0 and row["curr"] == 0:
            continue
        print(f"  {row['key']:<24} {prev:>7} {cur:>7} {delta:>7}  {row['status']}{note}")

    conv = diff["conversations"]
    print(
        f"\n  会话：续活跃 {conv['carried_over_n']}  新会话 {conv['new_n']}"
        f"  上窗有本窗无 {conv['dropped_n']}"
    )
    if conv["new"]:
        head = " ".join(_short(c) for c in conv["new"][:12])
        print(f"    新：{head}{' …' if len(conv['new']) > 12 else ''}")
    if conv["carried_over"]:
        head = " ".join(_short(c) for c in conv["carried_over"][:12])
        print(f"    续：{head}{' …' if len(conv['carried_over']) > 12 else ''}")
    print()


def main() -> None:
    opts = _parse_cli(sys.argv[1:])

    if opts.show_families:
        if opts.as_json:
            print(
                json.dumps(
                    {
                        "registry_digest": registry_digest(),
                        "families": [
                            {
                                "key": f.key,
                                "label": f.label,
                                "digest": f.digest(),
                                "revision": f.revision,
                                "since": f.since,
                                "aliases": list(f.aliases),
                                "events": list(f.events),
                                "patterns": list(f.patterns),
                                "detector": f.detector,
                                "must_review": f.key in MUST_REVIEW_FAMILIES,
                                "note": f.note,
                            }
                            for f in FAILURE_FAMILIES
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            _print_families_table()
        return

    if opts.diff_pair is not None:
        baseline = load_snapshot(opts.diff_pair[0])
        current = load_snapshot(opts.diff_pair[1])
        diff = diff_snapshots(baseline, current)
        if opts.as_json:
            print(json.dumps(diff, ensure_ascii=False, indent=2))
        else:
            _print_diff(diff)
        return

    log_file = _resolve_log_file(opts)
    if not discover_log_files(log_file):
        message = (
            f"Log file not found: {log_file}\n"
            "线上证据先 `pnpm sync:logs`，再 --export-dir ../../logs/prod-export；"
            "本地则用 logs/dev.jsonl。"
        )
        if opts.as_json:
            print(json.dumps({"error": "log_file_not_found", "path": str(log_file)}))
        else:
            print(message, file=sys.stderr)
        sys.exit(1)

    try:
        since = parse_since(opts.since_spec) if opts.since_spec else None
    except ValueError as e:
        raise SystemExit(str(e)) from e
    until = parse_timestamp(opts.until_spec) if opts.until_spec else None
    if opts.until_spec and until is None:
        raise SystemExit(f"Invalid --until {opts.until_spec!r}: 用 ISO 时间（YYYY-MM-DDTHH:MM:SSZ）")

    snapshot = scan_patrol(
        log_file,
        since=since,
        until=until,
        window_label=opts.window_label,
        include_synthetic=opts.include_synthetic,
        export_dir=opts.export_dir,
        max_ids=opts.max_ids,
        cluster_limit=opts.cluster_limit,
    )

    diff: dict[str, Any] | None = None
    if opts.baseline is not None:
        diff = diff_snapshots(load_snapshot(opts.baseline), snapshot.to_json_dict())

    written: Path | None = None
    if opts.snapshot_out is not None:
        written = write_snapshot(snapshot, opts.snapshot_out)

    if opts.as_json:
        payload: dict[str, Any] = snapshot.to_json_dict()
        if diff is not None:
            payload["diff"] = diff
        if written is not None:
            payload["snapshot_written"] = str(written)
        print(json.dumps(payload, ensure_ascii=False))
        return

    _print_snapshot(snapshot, top=opts.top)
    if diff is not None:
        _print_diff(diff)
    if written is not None:
        print(f"  快照已落盘（不入仓）：{written}\n")


if __name__ == "__main__":
    main()
