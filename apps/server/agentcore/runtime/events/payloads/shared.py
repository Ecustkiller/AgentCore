"""Shared wire leaf types referenced across SSE payload domains."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.payloads._base import WirePayload, absent


class UsageBreakdown(WirePayload):
    """Token counts in the ledger short-key form. `cache_hit + cache_miss === input`."""

    input: int
    output: int
    reasoning: int
    cache_hit: int
    cache_miss: int


class CostBreakdown(WirePayload):
    """A run's / turn's cost in integer nano-USD (1 USD = 1e9)."""

    input: int
    cached: int
    output: int
    total: int
    currency: str
    # Additive: missing on legacy vectors → default curated (compat).
    pricing_source: str = "curated"
    # BYOK estimate total when billed total is 0; absent on platform-only rows.
    estimated_total: int | None = absent()


class RunDebrief(WirePayload):
    """完工交接简报 — every field optional; absent when the worker did not call `handoff`."""

    summary: str | None = None
    key_points: list[str] | None = None
    assumptions: str | None = None
    next_steps: str | None = None


class Vec3(WirePayload):
    """3D position (R3F / Three.js Y-up): x=east, z=south, y=height."""

    x: float
    y: float
    z: float


class Citation(WirePayload):
    url: str
    title: str
    snippet: str | None = absent()
    site: str | None = absent()


class CitationsPayload(WirePayload):
    citations: list[Citation]


# Opaque alias — emitted as `export type ToolDisplay = Record<string, unknown>`.
ToolDisplayWire = dict[str, Any]
