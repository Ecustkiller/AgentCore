"""夜跑评测作业摘要：把「本次 AI 行为面到底考没考、结果如何」写成人读的 GitHub 作业摘要。

背景：夜跑的真跑步骤全是 ``continue-on-error``，无 key 时整段跳过，作业照样报绿；旧摘要
又用 ``if [ -f report.json ]`` 逐个渲染，文件不在就静默略过——于是「没考」与「考了全过」
在作业页上长得一模一样。本脚本反过来做：**先声明覆盖状态、再逐步骤列状态**，跳过 / 跑挂 /
未产出报告都必须显式写出来，不拿「没看见坏消息」冒充好消息。

**不改红绿**：恒以 0 退出，绿灯判定仍归 workflow（真跑步骤仍是软门禁）。

输入：``--reports-dir`` 下各步骤的 JSON、``EVAL_STEPS_JSON``（workflow 传的
``toJSON(steps)``，只取各步骤 ``outcome``）、``EVAL_KEY_PRESENT``。
输出：markdown 写 ``--out``（缺省 stdout）；``::warning::`` / ``::notice::`` 注解写 stdout，
让作业页顶部也能看见结论。

纯 stdlib、不 import ``agentcore``：摘要要在依赖装挂、真跑崩掉等任何失败态下都跑得起来。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# 真跑步骤未执行时的占位——刻意不留空，空白格会被读成「没问题」。
_NOT_RUN = "本次未考"


def _pct(value: Any) -> str:
    """0–1 概率 → 百分比文本；``None`` / 非数值 → ``n/a``。"""
    try:
        return f"{float(value) * 100:.0f}%"
    except (TypeError, ValueError):
        return "n/a"


def _num(value: Any, digits: int = 4) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "n/a"


# --- 各步骤报告 → 一行关键指标 ------------------------------------------------


def _ratchet_bit(data: dict[str, Any]) -> str:
    """棘轮回归门判定（由 ``python -m agentcore.evals --baseline`` 写进报告的 ratchet 段）。

    这里只渲染、不重算：门禁逻辑的唯一实现在 ``evals/report.py::baseline_regression``。
    """
    r = data.get("ratchet")
    if not isinstance(r, dict):
        return "棘轮：未接（应有而无）"
    if not r.get("available"):
        return "棘轮：无基线可比（本次落首个基线）"
    verdict = "回归" if r.get("regressed") else "未回归"
    return (
        f"棘轮：{_num(r.get('pass_rate'))} vs 基线 {_num(r.get('baseline_pass_rate'))}"
        f"（容差 {_num(r.get('tolerance'), 2)}）→ {verdict}"
    )


def _suite_line(data: dict[str, Any]) -> str:
    s = data.get("summary") or {}
    bits = [f"通过 {s.get('passed', 0)}/{s.get('total', 0)}（{_pct(s.get('pass_rate'))}）"]
    if s.get("cost_usd") is not None:
        bits.append(f"成本 ${_num(s.get('cost_usd'))}")
    return " · ".join(bits)


def _suite_ratchet_line(data: dict[str, Any]) -> str:
    return " · ".join([_suite_line(data), _ratchet_bit(data)])


def _routing_line(data: dict[str, Any]) -> str:
    r = data.get("routing") or {}
    return (
        f"准确率 {_pct(r.get('accuracy'))} · 过度编排 {_pct(r.get('over_delegation_rate'))}"
        f" · 组队不足 {_pct(r.get('under_delegation_rate'))} · 计入 {r.get('total', 0)} 例"
    )


def _style_line(data: dict[str, Any]) -> str:
    return f"干净率 {_pct(data.get('clean_rate'))}（计入 {data.get('total', 0)} 条回复）"


def _comparison_line(data: dict[str, Any]) -> str:
    s = data.get("summary") or {}
    by = s.get("by_archetype") or {}
    bits = [
        f"{arch} 均胜率 {_pct(b.get('avg_win_rate'))}"
        for arch, b in sorted(by.items())
        if isinstance(b, dict)
    ]
    head = f"对比 {s.get('total_cases', 0)} 例"
    return " · ".join([head, *bits]) if bits else f"{head}（无可比胜率）"


def _calibration_line(data: dict[str, Any]) -> str:
    gate = _num(data.get("kappa_gate"), 2)
    verdict = "裁判可信" if data.get("trustworthy") else "裁判不可信"
    bias = data.get("mean_bias")
    try:
        bias_text = f"{float(bias):+.2f}（{'偏宽松' if float(bias) > 0 else '偏严苛'}）"
    except (TypeError, ValueError):
        bias_text = "n/a"
    return (
        f"Cohen's kappa {_num(data.get('cohens_kappa'), 3)}（门 {gate}）→ {verdict}"
        f" · 样本 {data.get('n', 0)} · 偏置 {bias_text}"
    )


def _probe_code_line(data: dict[str, Any]) -> str:
    s = data.get("summary") or {}
    return f"通过 {s.get('passed', 0)}/{s.get('total', 0)}（{_pct(s.get('pass_rate'))}）"


def _mast_detail(data: dict[str, Any]) -> list[str]:
    """MAST 三大组通过率（协作铺开闸门看的就是「哪一类失败被压下去了」）。"""
    groups = ((data.get("summary") or {}).get("by_mast") or {}).get("by_group") or {}
    lines: list[str] = []
    for group, b in sorted(groups.items()):
        if not isinstance(b, dict):
            continue
        passed = int(b.get("passed", 0))
        total = int(b.get("total", 0))
        lines.append(f"- {group} {passed}/{total}（{_pct(b.get('pass_rate'))}）")
    return lines


# --- 步骤清单（顺序与 workflow 一致） ----------------------------------------


@dataclass(frozen=True)
class StepSpec:
    """一个真跑步骤：workflow 里的 step id、人读标题、报告文件名、指标渲染器。"""

    step_id: str
    title: str
    report: str
    render: Callable[[dict[str, Any]], str]
    detail_title: str = ""
    detail: Callable[[dict[str, Any]], list[str]] | None = None


STEPS: tuple[StepSpec, ...] = (
    # 顺序 = workflow 执行顺序（便于与日志对照）。校准排头：它最便宜，既能对坏凭据
    # 快速失败，也符合「先校尺、再拿尺子量」。
    StepSpec("calibrate", "裁判校准（判↔人 kappa）", "calibration.json", _calibration_line),
    StepSpec(
        "functional", "功能套件 L0+L1（含棘轮回归门）", "functional.json", _suite_ratchet_line
    ),
    StepSpec(
        "mast",
        "MAST 失败标签套件（含棘轮回归门）",
        "mast.json",
        _suite_ratchet_line,
        detail_title="MAST 分组通过率",
        detail=_mast_detail,
    ),
    StepSpec("routing", "路由准确率（混淆矩阵）", "routing.json", _routing_line),
    StepSpec("style", "输出风格 anti-slop", "style.json", _style_line),
    StepSpec("compare", "团队 vs 单体对比（成对裁判）", "comparison.json", _comparison_line),
    StepSpec("probe", "挖坑探针·算术地面真值", "probe.json", _suite_line),
    StepSpec("probe_code", "挖坑探针·代码必须真跑", "probe_code.json", _probe_code_line),
)


@dataclass
class StepRow:
    """一个步骤的渲染态：workflow 给的 outcome + 报告加载结果。"""

    spec: StepSpec
    outcome: str
    data: dict[str, Any] | None = None
    load_error: str = ""

    @property
    def ran(self) -> bool:
        """真跑是否**出了数**——报告在，才证明模型这一面真被考过。"""
        return self.data is not None

    @property
    def not_started(self) -> bool:
        return self.outcome in ("skipped", "missing", "cancelled")

    @property
    def status(self) -> str:
        if self.outcome == "cancelled":
            return "取消"
        if self.not_started:
            return "未执行"
        if self.outcome == "success":
            return "通过" if self.ran else "通过·未出数"
        return "已跑·未通过" if self.ran else "跑挂·未出数"

    @property
    def metric(self) -> str:
        if self.load_error:
            return self.load_error
        if self.data is None:
            return _NOT_RUN if self.not_started else "步骤未产出报告 JSON"
        return self.spec.render(self.data)


def load_rows(reports_dir: Path, steps: dict[str, Any]) -> list[StepRow]:
    """按 :data:`STEPS` 收集每个步骤的 outcome + 报告（报告缺失 / 损坏都如实留痕）。"""
    rows: list[StepRow] = []
    for spec in STEPS:
        entry = steps.get(spec.step_id)
        outcome = str(entry.get("outcome") or "missing") if isinstance(entry, dict) else "missing"
        row = StepRow(spec=spec, outcome=outcome)
        path = reports_dir / spec.report
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                row.load_error = f"报告无法解析（{type(e).__name__}）"
            else:
                row.data = loaded if isinstance(loaded, dict) else None
                if row.data is None:
                    row.load_error = "报告顶层不是对象"
        rows.append(row)
    return rows


# --- 结论 --------------------------------------------------------------------


@dataclass(frozen=True)
class Verdict:
    """摘要头部的覆盖结论 + 作业页注解。"""

    headline: str
    notes: list[str]
    annotation: str


def build_verdict(rows: list[StepRow], *, key_present: bool, gate_reached: bool = True) -> Verdict:
    """按「有没有真出数」定覆盖结论——绿灯从来不等于考过。

    ``gate_reached=False`` 表示连「查 key」那步都没跑到（装依赖 / 用例结构硬门禁先挂了），
    此时说「没配 key」是撒谎，得如实说真跑压根没启动。
    """
    total = len(rows)
    ran = [r for r in rows if r.ran]
    failed = [r for r in ran if r.outcome != "success"]
    broken = [r for r in rows if not r.ran and not r.not_started]
    soft = "真跑步骤是软门禁：作业照常报绿，绿灯**不代表** AI 行为无回归。"

    if not gate_reached and not ran:
        return Verdict(
            headline="**AI 行为面：本次未覆盖（真跑未启动）**",
            notes=[
                "前置步骤（装依赖 / 零 LLM 用例结构硬门禁）未通过，真模型评测根本没开始跑。",
                f"{total} 项 AI 行为评测无一执行；作业此时应已报红，按红灯处理。",
            ],
            annotation="::warning::AI 行为面本次未覆盖：前置步骤挂了，真跑未启动。",
        )

    if not key_present:
        return Verdict(
            headline="**AI 行为面：本次未覆盖**",
            notes=[
                f"未配 `EVAL_DEEPSEEK_API_KEY`，{total} 项真模型评测全部跳过。",
                "本次只过了零 LLM 的用例结构硬门禁——它守「用例写得对不对」，不守模型行为。",
                "作业报绿 **不代表** AI 行为无回归：这一面本次根本没考。",
            ],
            annotation=f"::warning::AI 行为面本次未覆盖：无 EVAL key，{total} 项真跑全部跳过。",
        )

    if not ran:
        return Verdict(
            headline="**AI 行为面：本次未覆盖（真跑全部未出数）**",
            notes=[
                f"配了 key，但 {total} 项真跑无一产出报告（凭据失效 / 额度耗尽 / 环境挂了）。",
                "详见各步骤日志。本次同样**没有**任何模型行为结论。",
                soft,
            ],
            annotation="::warning::AI 行为面本次未覆盖：真跑全部未出数，请查步骤日志。",
        )

    passed = [r for r in ran if r.outcome == "success"]
    notes = [
        f"出数 {len(ran)}/{total} 项：通过 {len(passed)}、"
        f"未通过 {len(failed)}、跑挂 {len(broken)}。"
    ]
    if len(ran) == total and not failed:
        return Verdict(
            headline="**AI 行为面：已覆盖，全部通过**",
            notes=[*notes, soft],
            annotation=f"::notice::AI 行为面全部通过（{len(passed)}/{total} 项）。",
        )

    notes.append(soft)
    if failed:
        notes.append("未通过：" + "、".join(r.spec.title for r in failed))
    if broken:
        notes.append("跑挂未出数（这几面本次没考成）：" + "、".join(r.spec.title for r in broken))
    skipped = [r for r in rows if r.not_started]
    if skipped:
        notes.append("未执行：" + "、".join(r.spec.title for r in skipped))
    # 全都出了数只是「考过了」，不等于考过了就算过——两者分开说。
    if len(ran) == total:
        headline = f"**AI 行为面：已覆盖，{len(failed)} 项未通过**"
    else:
        headline = f"**AI 行为面：部分覆盖（{len(ran)}/{total} 项出数）**"
    return Verdict(
        headline=headline,
        notes=notes,
        annotation=(
            f"::warning::AI 行为面 {len(failed)} 项未通过、"
            f"{len(broken) + len(skipped)} 项未考成（软门禁，不弄红作业）。"
        ),
    )


def calibration_note(rows: list[StepRow]) -> str:
    """裁判校准的落款：夜跑 pass/fail 主轴是 L1 裁判，它可不可信必须写在明面上。"""
    row = next((r for r in rows if r.spec.step_id == "calibrate"), None)
    if row is None or not row.ran:
        return (
            "**裁判校准未执行** —— L1 裁判与人工 gold 标注的一致度本次未验证，"
            "上面的 pass_rate 与棘轮判定都建立在一把没校准的尺子上。"
        )
    data = row.data or {}
    kappa = _num(data.get("cohens_kappa"), 3)
    gate = _num(data.get("kappa_gate"), 2)
    if data.get("trustworthy"):
        return f"**裁判已校准**：kappa {kappa} ≥ 门 {gate}，L1 pass_rate 与棘轮判定可当质量结论读。"
    return (
        f"**裁判未过校准**：kappa {kappa} < 门 {gate}，"
        "上面的 L1 pass_rate 与棘轮判定仅供观测，别当质量结论。"
    )


# --- 渲染 --------------------------------------------------------------------


def render(
    rows: list[StepRow], *, suite: str, key_present: bool, gate_reached: bool = True
) -> tuple[str, str]:
    """返回 ``(markdown 摘要, 作业页注解)``。"""
    verdict = build_verdict(rows, key_present=key_present, gate_reached=gate_reached)
    lines = [f"## AgentCore 夜跑评测（suite={suite}）", "", verdict.headline, ""]
    lines.extend(verdict.notes)
    lines.extend(["", "| 步骤 | 状态 | 关键指标 |", "| --- | --- | --- |"])
    for row in rows:
        lines.append(f"| {row.spec.title} | {row.status} | {row.metric} |")

    for row in rows:
        if row.spec.detail is None or not row.ran:
            continue
        detail = row.spec.detail(row.data or {})
        if detail:
            lines.extend(["", f"### {row.spec.detail_title}", *detail])

    lines.extend(["", calibration_note(rows)])
    if any(r.ran for r in rows):
        lines.extend(["", "逐例明细见本次运行的 `eval-reports` 制品。"])
    return "\n".join(lines) + "\n", verdict.annotation


def _parse_steps(raw: str) -> dict[str, Any]:
    """解析 workflow 传来的 ``toJSON(steps)``；坏数据不许拖垮摘要（全按未执行渲染）。"""
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python scripts/eval_nightly_summary.py",
        description="把夜跑评测的真实覆盖情况渲染成 GitHub 作业摘要（不改红绿）。",
    )
    p.add_argument("--reports-dir", default="eval-reports", help="报告目录（默认 eval-reports）")
    p.add_argument("--suite", default=None, help="功能套件名（缺省读环境变量 SUITE）")
    p.add_argument("--out", default=None, help="markdown 输出路径（缺省 stdout）")
    p.add_argument("--key-step", default="key", help="workflow 里『查 key』步骤的 id（默认 key）")
    args = p.parse_args(argv)

    suite = args.suite or os.environ.get("SUITE") or "core"
    key_present = os.environ.get("EVAL_KEY_PRESENT", "").strip().lower() == "true"
    steps = _parse_steps(os.environ.get("EVAL_STEPS_JSON", ""))
    # 查 key 那步跑过没：没跑过 = 前置就挂了，不能把它说成「没配 key」。
    gate_reached = isinstance(steps.get(args.key_step), dict)

    rows = load_rows(Path(args.reports_dir), steps)
    markdown, annotation = render(
        rows, suite=suite, key_present=key_present, gate_reached=gate_reached
    )

    if args.out:
        with Path(args.out).open("a", encoding="utf-8") as fh:
            fh.write(markdown)
    else:
        sys.stdout.write(markdown)
    print(annotation)
    return 0  # 摘要永不改红绿：软门禁的判定权仍在 workflow


if __name__ == "__main__":
    raise SystemExit(main())
