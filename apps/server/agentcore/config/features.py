"""Vertical / feature toggles (opt-in capability packs layered on the core)."""

from pydantic import BaseModel


class FeatureSettings(BaseModel):
    # Legal vertical v0 (法律垂直「答辩状作战室」). When on, the legal domain Skills
    # register into the CEO's system-skill registry (consultable + listed in the
    # 能力目录). Off by default so generic deployments never see legal content in the
    # catalog — the v0 stopgap until domain Skills move to per-agent market binding.
    legal_vertical_enabled: bool = False
