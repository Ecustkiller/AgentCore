"""BE-13: model routing tests."""

from __future__ import annotations

from agentcore.simulation.llm import (
    SimModelRouter,
    SimModelTier,
    default_routing_config,
)


def test_router_m2_uses_same_model_for_all_tiers():
    cfg = default_routing_config("deepseek-chat")
    router = SimModelRouter(cfg)
    assert router.resolve(SimModelTier.ROUTINE) == "deepseek-chat"
    assert router.resolve(SimModelTier.CRITICAL) == "deepseek-chat"


def test_router_from_run_manifest():
    manifest = {"model_routing": {"routine_model": "a", "critical_model": "b"}}
    router = SimModelRouter.from_run_config(manifest, fallback="fallback")
    assert router.resolve(SimModelTier.ROUTINE) == "a"
    assert router.resolve(SimModelTier.CRITICAL) == "b"


def test_router_falls_back_when_manifest_missing():
    router = SimModelRouter.from_run_config({}, fallback="default-model")
    assert router.resolve() == "default-model"
