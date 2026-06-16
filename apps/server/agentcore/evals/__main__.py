"""评估体系 CLI（§二 __main__.py）：一条命令跑完整套评测、出报告.

用法::

    python -m agentcore.evals                     # 跑 core 套件（Layer 1 确定性 Check）
    python -m agentcore.evals --suite core --mode quality
    python -m agentcore.evals --out report.json   # 同时写一份 JSON 报告
    python -m agentcore.evals --lint-only         # 只静态校验用例（零 LLM，per-PR 硬门禁）
    python -m agentcore.evals --compare           # 对比评估：团队 vs 单体（成对裁判，nightly）
    python -m agentcore.evals --compare --lint-only   # 只校验对比用例（零 LLM）

真跑（非 ``--lint-only``）会调真实 DeepSeek，需 ``EVAL_DEEPSEEK_API_KEY``（见 §十三）；
``--compare`` 的成对裁判默认固定 Pro 档，可经 ``EVAL_JUDGE_MODEL`` 覆盖。
退出码：全过=0；有用例未过=1；用例配置/加载错误=2——便于挂 CI。
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
from agentcore.evals.report import format_report, report_to_dict
from agentcore.evals.runner import load_cases, run_suite
from agentcore.evals.types import EvalConfigError


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m agentcore.evals",
        description="AgentCore 离线评估：把黄金用例喂给真实运行路径，确定性断言出回归报告。",
    )
    p.add_argument("--suite", default="core", help="用例套件 cases/<suite>/*.json（默认 core）")
    p.add_argument(
        "--layer",
        type=int,
        default=1,
        choices=[1, 2],
        help="1=确定性 Check；2=+LLM 裁判（P1 未落地，自动降级为 1）",
    )
    p.add_argument("--mode", default=None, help="覆盖所有用例的质量档：economy / quality / 自定义")
    p.add_argument("--cases-dir", default=None, help="用例根目录（默认包内 cases/）")
    p.add_argument("--out", default=None, help="把 JSON 报告写到该路径（baseline / 回归对比用）")
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


async def _run(args: argparse.Namespace) -> int:
    if args.compare:
        return await _run_comparison(args)

    cases = load_cases(args.cases_dir, suite=args.suite)
    if args.mode:
        cases = [replace(c, mode=args.mode) for c in cases]

    if args.lint_only:
        print(f"[lint] OK — {len(cases)} 个用例结构合法（suite={args.suite}）")
        return 0

    layer = args.layer
    if layer >= 2:
        print(
            "[warn] Layer 2 LLM 裁判尚未落地（P1）；本次按 Layer 1 确定性 Check 运行。",
            file=sys.stderr,
        )
        layer = 1

    report = await run_suite(cases, judge=None, layer=layer)
    print(format_report(report))

    if args.out:
        out = Path(args.out)
        out.write_text(
            json.dumps(report_to_dict(report), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\n[report] 已写出 JSON -> {out}")

    return 0 if report.passed == report.total else 1


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except EvalConfigError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
