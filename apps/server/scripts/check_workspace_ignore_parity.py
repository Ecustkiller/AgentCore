#!/usr/bin/env python3
"""CLI for workspace hide-rule parity (Python ↔ desktop TypeScript).

Covers the ignore lists (dirs / suffix tiers) and the internal-zone names +
``AgentCore/<zone>`` path forms, which are hand-copied into four files.

Usage (from apps/server)::

    uv run python scripts/check_workspace_ignore_parity.py
    uv run python scripts/check_workspace_ignore_parity.py --simulate-drift

Wired into ``pnpm release:gate`` (backend section) and unit pytest.
"""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Workspace hide-rule parity: ignore lists (_paths.py ↔ "
            "workspaceIgnore.ts) + internal zones (stage_dirs.py ↔ "
            "workspaceIgnore.ts ↔ renderer workspaceSource.ts)"
        )
    )
    parser.add_argument(
        "--simulate-drift",
        action="store_true",
        help="Self-test: inject a phantom TS member and expect failure",
    )
    args = parser.parse_args(argv)

    from agentcore.workspace.ignore_parity import run_ignore_parity

    result = run_ignore_parity(simulate_drift=args.simulate_drift)
    for label, path in result.sources:
        print(f"{label}: {path}")

    if result.ok:
        if args.simulate_drift:
            print("✗ ignore parity unexpectedly passed under --simulate-drift")
            return 1
        print("✓ workspace hide rules aligned (dirs / system / ai-noise / internal zones)")
        return 0

    print("✗ workspace hide-rule parity FAILED — Python ↔ TypeScript diverge:")
    for err in result.errors:
        print(f"  - {err}")
    if args.simulate_drift:
        print("✓ simulate-drift intercepted mismatch as expected")
        return 0
    print("  Fix: edit every side listed above, then re-run.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
