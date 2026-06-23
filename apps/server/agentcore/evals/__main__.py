"""评估体系 CLI（评测体系重设计 §三/§七）：一条命令跑完整套评测、出报告.

用法::

    python -m agentcore.evals                  # core：L0 不变量 + L1 rubric 裁判（默认 layer 2）
    python -m agentcore.evals --layer 1        # 仅 L0 确定性 Check（无裁判，便宜）
    python -m agentcore.evals --out report.json
    python -m agentcore.evals --lint-only      # 只静态校验用例（零 LLM，per-PR 硬门禁）
    python -m agentcore.evals --update-baseline   # 落 baseline（回归门基准）后退出
    python -m agentcore.evals --baseline eval-out/core-baseline.json  # 跑回归门（跌破即非 0）
    python -m agentcore.evals --compare        # 对比评估：团队 vs 单体（成对裁判，诊断）

真跑（非 ``--lint-only``）会调真实 DeepSeek，需 ``EVAL_DEEPSEEK_API_KEY``。L1 绝对分裁判默认
固定 Pro 档（Pro 评 Flash，压同家族自偏好），可经 ``EVAL_JUDGE_MODEL`` 覆盖模型。
退出码：全过/未回归=0；有用例未过或跌破 baseline=1；用例配置/加载错误=2——便于挂 CI。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import replace
from pathlib import Path

from agentcore.evals.comparison import (
    build_default_pairwise_judge,
    comparison_report_to_dict,
    format_comparison_report,
    load_comparison_cases,
    run_comparison_suite,
)
from agentcore.evals.judge import build_default_judge
from agentcore.evals.report import baseline_regression, format_report, report_to_dict
from agentcore.evals.routing import (
    format_routing_report,
    routing_metrics,
    routing_metrics_to_dict,
)
from agentcore.evals.runner import load_cases, run_suite
from agentcore.evals.style_lint import (
    format_style_report,
    style_metrics,
    style_metrics_to_dict,
)
from agentcore.evals.types import EvalConfigError

# baseline 默认落盘到 apps/server/eval-out/（绝对路径，与 CLI 的 cwd 无关）。
_DEFAULT_EVAL_OUT = Path(__file__).resolve().parents[2] / "eval-out"


def _default_baseline_path(suite: str) -> Path:
    return _DEFAULT_EVAL_OUT / f"{suite}-baseline.json"


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m agentcore.evals",
        description="AgentCore 离线评估：把黄金用例喂给真实运行路径，确定性断言出回归报告。",
    )
    p.add_argument("--suite", default="core", help="用例套件 cases/<suite>/*.json（默认 core）")
    p.add_argument(
        "--layer",
        type=int,
        default=2,
        choices=[1, 2],
        help="2=L0 不变量 + L1 rubric 裁判主轴（默认，需 key）；1=仅 L0 确定性 Check（无裁判）",
    )
    p.add_argument("--mode", default=None, help="覆盖所有用例的质量档：economy / quality / 自定义")
    p.add_argument(
        "--judge-mode",
        default="quality",
        help="裁判档（默认 quality→Pro，即 Pro 评 Flash；EVAL_JUDGE_MODEL 可覆盖）",
    )
    p.add_argument("--cases-dir", default=None, help="用例根目录（默认包内 cases/）")
    p.add_argument("--out", default=None, help="把 JSON 报告写到该路径（baseline / 回归对比用）")
    p.add_argument(
        "--baseline",
        default=None,
        help="baseline JSON 路径：存在则跑回归门（跌破即非 0）；配 --update-baseline 则写入",
    )
    p.add_argument(
        "--update-baseline",
        action="store_true",
        help="把报告写为 baseline 后退出（缺省 eval-out/<suite>-baseline.json）",
    )
    p.add_argument(
        "--regression-tolerance",
        type=float,
        default=0.05,
        help="回归门容差：当前 pass_rate < baseline-容差 才判回归（吸收真模型非确定性，默认 0.05）",
    )
    p.add_argument(
        "--lint-only",
        action="store_true",
        help="只做用例静态校验、不跑模型（零 LLM，per-PR 硬门禁）",
    )
    p.add_argument(
        "--compare",
        action="store_true",
        help="对比评估（团队 vs 单体）：跑 cases/comparison/，成对裁判 + 三轴报告（nightly）",
    )
    p.add_argument(
        "--routing",
        action="store_true",
        help="路由准确率：跑 cases/routing/，确定性 Check + 混淆矩阵（CEO 自己做 vs 交团队）",
    )
    p.add_argument(
        "--style",
        action="store_true",
        help="输出风格违规：跑套件后对回复跑 anti-slop linter，出违规率（先可观测，方向④）",
    )
    return p


async def _run_comparison(args: argparse.Namespace) -> int:
    """对比评估分支：跑 comparison 套件、成对裁判、按 archetype 分段报告。"""
    suite = args.suite if args.suite != "core" else "comparison"
    cases = load_comparison_cases(args.cases_dir, suite=suite)
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]

    if args.lint_only:
        print(f"[lint] OK — {len(cases)} 个对比用例结构合法（suite={suite}）")
        return 0

    judge = build_default_pairwise_judge()
    report = await run_comparison_suite(cases, judge=judge, layer=2)
    print(format_comparison_report(report))

    if args.out:
        out = Path(args.out)
        out.write_text(
            json.dumps(comparison_report_to_dict(report), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\n[report] 已写出 JSON -> {out}")
    return 0  # 对比为软门禁（信息性），不以胜率卡退出码


async def _run_routing(args: argparse.Namespace) -> int:
    """路由准确率分支：跑 routing 套件、确定性 Check，再聚合混淆矩阵（方向③）。

    度量本身需真模型 CEO 回合（属已延后的 eval 主线）；故未过用例照 Layer 1 卡退出码，
    混淆矩阵为信息性附加视图。``--lint-only`` 时零 LLM、只校验用例结构（含路由标签唯一性）。
    """
    suite = args.suite if args.suite != "core" else "routing"
    cases = load_cases(args.cases_dir, suite=suite)
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]

    if args.lint_only:
        print(f"[lint] OK — {len(cases)} 个路由用例结构合法（suite={suite}）")
        return 0

    report = await run_suite(cases, judge=None, layer=1)
    print(format_report(report))
    metrics = routing_metrics(report.cases)
    print("\n" + format_routing_report(metrics))

    if args.out:
        out = Path(args.out)
        out.write_text(
            json.dumps(
                {"report": report_to_dict(report), "routing": routing_metrics_to_dict(metrics)},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\n[report] 已写出 JSON -> {out}")

    return 0 if report.passed == report.total else 1


async def _run_style(args: argparse.Namespace) -> int:
    """风格违规分支：跑套件 → 对每条回复跑 anti-slop linter → 出违规率（方向④「先可观测」）.

    与 ``--routing`` 同构：linter 规则纯确定性、可零 LLM 单测，但**被检文本**需真模型回合
    产生，故出数仍挂在已延后的真跑评测主线上。报告为信息性（软门禁），不以违规率卡退出码。
    """
    cases = load_cases(args.cases_dir, suite=args.suite)
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]

    if args.lint_only:
        print(f"[lint] OK — {len(cases)} 个用例结构合法（suite={args.suite}）")
        return 0

    report = await run_suite(cases, judge=None, layer=1)
    metrics = style_metrics(report.cases)
    print(format_style_report(metrics))

    if args.out:
        out = Path(args.out)
        out.write_text(
            json.dumps(style_metrics_to_dict(metrics), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\n[report] 已写出 JSON -> {out}")
    return 0  # 风格为软门禁（信息性），不以违规率卡退出码


async def _run(args: argparse.Namespace) -> int:
    if args.compare:
        return await _run_comparison(args)
    if args.routing:
        return await _run_routing(args)
    if args.style:
        return await _run_style(args)

    cases = load_cases(args.cases_dir, suite=args.suite)
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]

    if args.lint_only:
        print(f"[lint] OK — {len(cases)} 个用例结构合法（suite={args.suite}）")
        return 0

    # L1 主轴：layer>=2 时构造绝对分裁判（默认 Pro 评 Flash），按 case.rubric 给 1–5 分计入判定。
    judge = build_default_judge(mode=args.judge_mode) if args.layer >= 2 else None
    report = await run_suite(cases, judge=judge, layer=args.layer)
    print(format_report(report))

    if args.out:
        out = Path(args.out)
        out.write_text(
            json.dumps(report_to_dict(report), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\n[report] 已写出 JSON -> {out}")

    # baseline：--update-baseline 写盘后退出；否则给定 --baseline 且文件存在则跑回归门。
    if args.update_baseline:
        path = Path(args.baseline) if args.baseline else _default_baseline_path(args.suite)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(report_to_dict(report), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[baseline] 已更新 -> {path}")
        return 0

    exit_code = 0 if report.passed == report.total else 1
    if args.baseline:
        bpath = Path(args.baseline)
        if bpath.is_file():
            baseline = json.loads(bpath.read_text(encoding="utf-8"))
            regressed, detail = baseline_regression(report, baseline, args.regression_tolerance)
            print(f"[baseline] {detail}")
            if regressed:
                exit_code = 1
        else:
            print(f"[baseline] 未找到 {bpath}（跳过回归门；首跑用 --update-baseline 落基线）")
    return exit_code


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except EvalConfigError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
