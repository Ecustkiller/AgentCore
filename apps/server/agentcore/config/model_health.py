"""Periodic per-model reachability probes (``llm/model_health.py``)."""

from pydantic import BaseModel


class ModelHealthSettings(BaseModel):
    # Off → no background sweep. The manual "重新检测" path still works, so a
    # deployment that does not want the outbound calls can still refresh on demand.
    llm_model_health_probe_enabled: bool = True
    # Half an hour: free-tier rotation is a days-scale event, and each sweep costs
    # one tiny completion per plausible id. Shorter buys latency nobody needs.
    # This is only when the sweep *looks*; what it may actually re-ask is
    # governed by the two freshness windows below.
    llm_model_health_probe_interval_seconds: float = 1800.0
    # Re-ask after 2h. Throttled/timeout answers are weather — worth rechecking.
    llm_model_health_reprobe_seconds: float = 7200.0
    # Re-ask a *free* id that already answered ok/dead only twice a day. These
    # share a hard daily request allowance (OpenRouter: 50/day without a topped-up
    # balance), so a half-hourly sweep would spend the allowance on the sweep
    # itself and make every free model look rate limited — measured, not theorised.
    llm_model_health_free_reprobe_seconds: float = 43200.0
    # Per-endpoint ceiling. The probed set is small by construction (profile pins
    # ∪ preset seeds); this is a backstop, not the normal size. 0 → no cap.
    llm_model_health_probe_max_models: int = 25
