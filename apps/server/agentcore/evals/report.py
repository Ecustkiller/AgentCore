"""报告聚合 + JSON 序列化 + 控制台美化（评估体系 §二 report.py）.

纯函数，吃 :class:`~agentcore.evals.types.EvalReport`，产出 (1) 可落盘/对比 baseline 的
JSON dict 与 (2) 控制台文本。刻意用 ASCII 标记（``[+]``/``[-]``）而非 ✓/✗——Windows 控制台
默认 GBK 编码下 unicode 勾叉会乱码。
"""

from __future__ import annotations

from agentcore.evals.types import CaseReport, EvalReport


def category_breakdown(report: EvalReport) -> dict[str, dict[str, float]]:
    """按类别聚合：``{category: {total, passed, pass_rate}}``（samples>1 时同 case 多条计入）。"""
    by_cat: dict[str, dict[str, float]] = {}
    for c in report.cases:
        bucket = by_cat.setdefault(c.category, {"total": 0, "passed": 0})
        bucket["total"] += 1
        if c.passed:
            bucket["passed"] += 1
    for bucket in by_cat.values():
        total = bucket["total"]
        bucket["pass_rate"] = round(bucket["passed"] / total, 4) if total else 0.0
    return by_cat


def _case_to_dict(c: CaseReport) -> dict:
    o = c.outcome
    return {
        "case_id": c.case_id,
        "category": c.category,
        "passed": c.passed,
        "checks": [
            {"name": ck.name, "passed": ck.passed, "detail": ck.detail, "gating": ck.gating}
            for ck in c.checks
        ],
        "judge": (
            None
            if c.judge is None
            else {
                "score": c.judge.score,
                "passed": c.judge.passed,
                "rationale": c.judge.rationale,
            }
        ),
        "outcome": {
            "finish_reason": o.finish_reason,
            "rounds": o.rounds,
            "delegated": o.delegated,
            "roster": o.roster,
            "tool_calls": [name for name, _ in o.tool_calls],
            "citations": len(o.citations),
            "usage": o.usage,
            "cost_usd": round(o.cost_usd, 6),
            "latency_ms": o.latency_ms,
            "error": o.error,
            "content_preview": (o.content[:200] if o.content else ""),
        },
    }


def report_to_dict(report: EvalReport) -> dict:
    """整套报告 → JSON-able dict（汇总 + 逐例）。落盘为 baseline、供 P2 回归对比。"""
    total_cost = round(sum(c.outcome.cost_usd for c in report.cases), 6)
    return {
        "summary": {
            "total": report.total,
            "passed": report.passed,
            "pass_rate": round(report.pass_rate, 4),
            "cost_usd": total_cost,
            "by_category": category_breakdown(report),
        },
        "cases": [_case_to_dict(c) for c in report.cases],
    }


def format_report(report: EvalReport) -> str:
    """控制台文本报告（逐例 + 分类通过率 + 总账）。"""
    lines: list[str] = ["=" * 64, "AgentCore 评估报告", "=" * 64]
    for c in report.cases:
        status = "PASS" if c.passed else "FAIL"
        lines.append(f"[{status}] {c.case_id}  ({c.category})")
        for ck in c.checks:
            # 诊断 Check（gating=False）不计入判定：用 [~] 标记区别于门禁 [+]/[-]，避免误读为失败。
            mark = "[~]" if not ck.gating else ("[+]" if ck.passed else "[-]")
            suffix = " (诊断)" if not ck.gating else ""
            lines.append(f"    {mark} {ck.name}{suffix}: {ck.detail}")
        if c.judge is not None:
            mark = "[+]" if c.judge.passed else "[-]"
            lines.append(f"    {mark} Judge {c.judge.score}: {c.judge.rationale[:80]}")
        if c.outcome.error:
            lines.append(f"    !!! error: {c.outcome.error}")
    lines.append("-" * 64)
    for cat, bucket in sorted(category_breakdown(report).items()):
        passed = int(bucket["passed"])
        total = int(bucket["total"])
        pct = bucket["pass_rate"] * 100
        lines.append(f"  {cat:<14} {passed}/{total}  ({pct:.0f}%)")
    lines.append("-" * 64)
    total_cost = sum(c.outcome.cost_usd for c in report.cases)
    pct = report.pass_rate * 100
    lines.append(f"总计: {report.passed}/{report.total} 通过 ({pct:.0f}%)   成本 ${total_cost:.4f}")
    lines.append("=" * 64)
    return "\n".join(lines)


def baseline_regression(report: EvalReport, baseline: dict, tolerance: float) -> tuple[bool, str]:
    """对比当前报告与 baseline 的**总通过率**；跌破 ``baseline - tolerance`` 判回归（评测体系
    重设计 §七：L1 跌破 baseline 超阈 → 红）。

    返回 ``(是否回归, 人读说明)``。``tolerance`` 吸收真模型非确定性（思考模型不吃 temperature，
    单次跑天然抖动）——只有显著掉档才算回归，避免噪声把门弄红。baseline 缺 ``pass_rate`` 视为 0。
    """
    base_rate = float(baseline.get("summary", {}).get("pass_rate", 0.0))
    cur = report.pass_rate
    regressed = cur < base_rate - tolerance
    detail = (
        f"pass_rate {cur:.4f} vs baseline {base_rate:.4f}"
        f"（容差 {tolerance:.2f}）→ {'回归' if regressed else 'OK'}"
    )
    return regressed, detail
