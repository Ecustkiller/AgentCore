"""Model profiles: the single source of truth for every LLM usage scenario.

Each scenario (chat, agent tiers, memory, title) is a
named ``ModelProfile`` bundling the model + sampling params + the ReAct round
budget. Call sites resolve a profile and use ``build_request`` to spread it into
an ``LLMRequest`` — no per-site copying of model/temperature/thinking/... .

Growth invariant: the profile count tracks the number of *distinct usage
scenarios*, never the number of parameter combinations. Add a profile only for a
genuinely new scenario — not to express a one-off knob tweak (use
``apply_overrides`` for per-agent capability bumps). Several profiles share most
params today (the thinking tiers differ only in ``max_rounds``; memory/title only
in ``max_tokens``); they stay separate because their *evolution* diverges — e.g.
质量档 lifts ``chat`` and ``agent.strong`` to Pro independently — not because
their current values differ. Merging on present-day similarity would couple
scenarios that are meant to move apart.

The ``delegate`` worker vocabulary is the two-value ``ModelTier`` (fast/
strong); ``agent_profile`` maps a tier to its concrete agent profile. The single
high-frequency chat/default reply path uses its own standalone ``chat`` profile,
kept apart from the two tiers so a mode can lift one without dragging the other.
Profiles are an internal implementation concern and are intentionally NOT exposed
to the worker LLMs.

The ``model`` on each profile here is the **economy base** (Flash). Per-turn model
selection — the user-facing 质量档 (经济/高质量/custom) — is layered on top in
``llm/modes.py`` (``ProfileSet``), which swaps a profile's model per team role
while leaving these params untouched. The retired ``_STRONG_MODEL`` flip lives on
as the ``quality`` preset there.

Derived from DeepSeek V4 API constraints documented in .cursor/rules/llm.mdc.
"""

from dataclasses import dataclass, replace
from typing import Literal

from agentcore.core.types import ModelTier
from agentcore.llm.protocol import LLMMessage, LLMRequest


@dataclass(frozen=True)
class ModelProfile:
    """Full LLM profile for one usage scenario: model params + execution budget.

    ``max_rounds`` is the ReAct loop cap consumed by ``engine.react_loop``;
    one-shot ``complete`` callers (memory/title) leave
    it at a small default since they never loop.
    """

    model: str
    thinking: bool = True
    reasoning_effort: Literal["high", "max"] | None = "high"
    temperature: float = 0.7
    max_tokens: int | None = None
    max_rounds: int = 16


# DeepSeek V4 model identifiers
DEEPSEEK_V4_FLASH = "deepseek-v4-flash"
DEEPSEEK_V4_PRO = "deepseek-v4-pro"


# Single source of truth: every LLM usage scenario is declared here. The two
# worker tiers are keyed "agent.<tier>" so agent_profile() can map a
# delegate model_preference (a ModelTier) straight to a concrete profile. The
# single-chat/default reply path uses the standalone "chat" profile (not a tier),
# decoupling everyday chat cost/latency from the strong tier.
PROFILES: dict[str, ModelProfile] = {
    # Single-agent / default chat reply: the highest-frequency path. A standalone
    # profile (not a tier) so a mode can lift it (高质量档 → Pro) independently of
    # the worker tiers. Base model = Flash (economy); the sweet spot stays: thinking
    # on, high effort, mid rounds.
    "chat": ModelProfile(
        model=DEEPSEEK_V4_FLASH,
        thinking=True,
        reasoning_effort="high",
        temperature=0.7,
        max_rounds=16,
    ),
    # Light tier: simpler, well-scoped sub-tasks (fetch / format / single lookup /
    # light rewrite). Thinks at "high" like strong, but with a small round budget
    # and no per-agent max unlock — so it stays the cheaper/faster of the two
    # tiers without dropping to non-thinking. (Dev-stage decision 2026-06-14:
    # collapse worker tiers onto the two effective thinking levels high/max; no
    # non-thinking worker tier.)
    "agent.fast": ModelProfile(
        model=DEEPSEEK_V4_FLASH,
        thinking=True,
        reasoning_effort="high",
        temperature=0.7,
        max_rounds=4,
    ),
    # Strong tier: sub-tasks needing reasoning / quality. Its BASE model is Flash
    # (the economy default); the ``quality`` mode preset (llm/modes.py) lifts it to
    # Pro per user/conversation/operator-default. Effort stays "high"; "max" is
    # unlocked per-agent on demand (提案 B), not the tier default.
    "agent.strong": ModelProfile(
        model=DEEPSEEK_V4_FLASH,
        thinking=True,
        reasoning_effort="high",
        temperature=0.7,
        max_rounds=28,
    ),
    "memory": ModelProfile(
        model=DEEPSEEK_V4_FLASH,
        thinking=False,
        reasoning_effort=None,
        temperature=0.3,
        max_rounds=1,
    ),
    # One-line conversation title: fast, non-thinking, short output.
    # 64 tokens leaves headroom for a ~16-char CJK title without mid-title cutoff.
    "title": ModelProfile(
        model=DEEPSEEK_V4_FLASH,
        thinking=False,
        reasoning_effort=None,
        temperature=0.3,
        max_tokens=64,
        max_rounds=1,
    ),
}

# Universal safe fallback for an unknown profile name or invalid tier: the chat
# profile (thinking on, moderate budget, always valid).
_DEFAULT_PROFILE = "chat"


def get_profile(name: str) -> ModelProfile:
    """Resolve a named profile, falling back to the chat profile."""
    return PROFILES.get(name, PROFILES[_DEFAULT_PROFILE])


def agent_profile(preference: ModelTier | str) -> ModelProfile:
    """Map a delegate worker model_preference (fast/strong) to a profile.

    Replaces the former _PREF_TO_ROLE / _PREF_TO_ROUNDS bridge dicts: a single
    agent profile now carries both the model params and the per-tier round budget.
    """
    pref = preference.value if isinstance(preference, ModelTier) else str(preference)
    return get_profile(f"agent.{pref}")


# Monotonic capability ordering for reasoning effort (None = non-thinking tier).
# Used to clamp per-agent overrides to "upgrade only".
_EFFORT_RANK: dict[str | None, int] = {None: 0, "high": 1, "max": 2}


def apply_overrides(
    profile: ModelProfile,
    *,
    thinking: bool | None = None,
    reasoning_effort: str | None = None,
) -> ModelProfile:
    """Apply per-agent knob overrides onto a tier profile (提案 B).

    Overrides let the CEO unlock 极复杂 (thinking + ``max``) on a single
    agent without raising the whole tier. They are **upgrade-only**: an override
    can raise capability but never lower it, so the CEO can never
    silently degrade a tier's quality (turn thinking off / drop effort).
    Downgrades are expressed by choosing the ``fast`` tier instead. A ``None``
    override means "not declared" → keep the tier default.

    - ``thinking``: only ``False→True`` takes effect; a declared ``False`` is
      ignored when the tier already thinks.
    - ``reasoning_effort``: clamped to the stronger of tier vs. override along
      ``None < high < max``; a weaker declaration is ignored. Declaring any
      effort implies thinking (effort is meaningless otherwise), and thinking
      with no resolved effort falls back to DeepSeek's default ``high``.
    """
    new_thinking = profile.thinking or bool(thinking)

    new_effort = profile.reasoning_effort
    if reasoning_effort is not None and (
        _EFFORT_RANK.get(reasoning_effort, 0) > _EFFORT_RANK.get(new_effort, 0)
    ):
        new_effort = reasoning_effort  # type: ignore[assignment]

    if new_effort is not None:
        new_thinking = True
    if new_thinking and new_effort is None:
        new_effort = "high"

    if new_thinking == profile.thinking and new_effort == profile.reasoning_effort:
        return profile
    return replace(profile, thinking=new_thinking, reasoning_effort=new_effort)


def build_request(
    profile: ModelProfile,
    messages: list[LLMMessage],
    *,
    tools: list[dict] | None = None,
    tool_choice: Literal["auto", "none", "required"] = "auto",
    stream: bool = True,
) -> LLMRequest:
    """Spread a ModelProfile into an LLMRequest.

    The single place that knows how a profile maps onto request fields, so call
    sites never hand-copy model/temperature/thinking/reasoning_effort/max_tokens.
    ``max_rounds`` is a ReAct-loop budget, not an API field, so it is
    intentionally not part of the request.
    """
    return LLMRequest(
        messages=messages,
        model=profile.model,
        temperature=profile.temperature,
        max_tokens=profile.max_tokens,
        thinking=profile.thinking,
        reasoning_effort=profile.reasoning_effort,
        tools=tools,
        tool_choice=tool_choice if tools else "none",
        stream=stream,
    )
