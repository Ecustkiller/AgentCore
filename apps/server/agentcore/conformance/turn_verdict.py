"""Optional turnOutcome comparison sidecar on conformance fixtures.

Not a third UI arbiter. Probe vectors (``turn_verdict_*``) get a *partial*
envelope of wire-grounded / already-documented host facts so both frontends'
native ``lib/turnOutcome`` outputs can be diffed by the existing harness.

Golden host values follow the landed product rule (协作图 UX: 有团队图时条只报战绩，
失败说明在输入区横幅，排查包在气泡「更多」).
"""

from __future__ import annotations

from typing import Any


def project_turn_verdict(name: str, _projected: dict[str, Any]) -> dict[str, Any] | None:
    if name == "turn_verdict_team_host":
        return {
            "hasTeamStrip": True,
            "supportPackHost": "more",
        }
    return None
