"""OpenAI-compatible wire dialects — declarative flags looked up by model id.

Provider payload / probe paths consult :func:`resolve_wire_dialect` instead of
scattered ``model.startswith`` / ``_is_deepseek_*`` branches. Adding a new
dialect is a table row (or flag overlay), not a new ``if`` in the provider.

Match kinds (against the wire leaf after stripping optional ``provider/``):

- ``exact`` — leaf equals pattern
- ``prefix`` — leaf startswith pattern
- ``contains`` — pattern appears anywhere in the leaf

Overlays OR-merge True flags (e.g. ``deepseek-v4-*`` hits both the DeepSeek
echo prefix and the V4 thinking-type prefix). Overlay fields that are ``None``
mean "no opinion" and leave the running default alone.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from agentcore.llm.byok_provider_presets import match_byok_provider_preset

MatchKind = Literal["exact", "prefix", "contains"]


@dataclass(frozen=True)
class WireDialect:
    """Wire-shape behaviour for one resolved model id (defaults = clean OpenAI)."""

    # Assistant+tool_calls turns must echo ``reasoning_content`` (incl. "").
    echo_reasoning_content: bool = False
    # Honors ``thinking: {type: enabled|disabled}`` on the request body.
    thinking_type_switch: bool = False
    # Upstream rejects wire ``temperature`` — omit rather than send a default.
    omit_temperature: bool = False
    # ``probe_tools``: HTTP 400 under ``tool_choice=required`` → retry without it.
    # Default True preserves the historical universal fallback (DeepSeek V4 etc.).
    retry_forced_tool_choice_on_400: bool = True


@dataclass(frozen=True)
class _DialectOverlay:
    """One match rule → optional flag overlays (``None`` = leave running value)."""

    kind: MatchKind
    pattern: str
    echo_reasoning_content: bool | None = None
    thinking_type_switch: bool | None = None
    omit_temperature: bool | None = None
    retry_forced_tool_choice_on_400: bool | None = None

    def matches(self, leaf: str) -> bool:
        if self.kind == "exact":
            return leaf == self.pattern
        if self.kind == "prefix":
            return leaf.startswith(self.pattern)
        return self.pattern in leaf


def wire_model_leaf(model: str) -> str:
    """Strip optional ``provider/`` prefix; compare on the leaf id only."""
    return model.rsplit("/", 1)[-1].lower()


# Declarative overlays. Order does not matter (OR-merge of True / explicit sets).
# Prefer adding a row here over a new model-name branch in ``openai_compatible``.
_DIALECT_OVERLAYS: tuple[_DialectOverlay, ...] = (
    # DeepSeek family: tool-loop must echo reasoning_content.
    _DialectOverlay("prefix", "deepseek", echo_reasoning_content=True),
    # DeepSeek V4 (+ Hy3 below): thinking.type enabled/disabled switch.
    _DialectOverlay("prefix", "deepseek-v4", thinking_type_switch=True),
    # Hy3 / Hy3 Preview only — other TokenHub ``hy-*`` stay clean OpenAI.
    _DialectOverlay(
        "exact",
        "hy3",
        echo_reasoning_content=True,
        thinking_type_switch=True,
    ),
    _DialectOverlay(
        "exact",
        "hy3-preview",
        echo_reasoning_content=True,
        thinking_type_switch=True,
    ),
    # Anthropic effort / sampling-restricted leaves reject ``temperature``.
    # Keep markers narrow; do not blanket all ``claude-*``.
    *tuple(
        _DialectOverlay("contains", marker, omit_temperature=True)
        for marker in (
            "opus-4-7",
            "opus-4.7",
            "opus-4-8",
            "opus-4.8",
            "opus-5",
            "fable-5",
            "mythos-5",
        )
    ),
    # Kimi leaf ids (incl. OpenCode Zen / other relays hosting ``kimi-*``).
    # Do not blanket whole endpoints that happen to list Kimi models.
    _DialectOverlay("prefix", "kimi-", omit_temperature=True),
)


def resolve_wire_dialect(model: str, *, base_url: str | None = None) -> WireDialect:
    """Look up wire dialect flags for ``model`` (supports ``provider/leaf`` ids).

    Optional ``base_url`` enables vendor-endpoint overlays (e.g. Moonshot BYOK
    short ids like ``k3``). Multi-model hubs (OpenCode Zen) must not omit for
    every model just because the catalog includes ``kimi-*`` — Zen relies on
    the ``kimi-`` leaf rule above.
    """
    leaf = wire_model_leaf(model)
    echo = False
    thinking = False
    omit_temp = False
    # Universal default: keep forced-tool_choice 400 retry (historical behaviour).
    retry_required = True
    for rule in _DIALECT_OVERLAYS:
        if not rule.matches(leaf):
            continue
        if rule.echo_reasoning_content is not None:
            echo = echo or rule.echo_reasoning_content
        if rule.thinking_type_switch is not None:
            thinking = thinking or rule.thinking_type_switch
        if rule.omit_temperature is not None:
            omit_temp = omit_temp or rule.omit_temperature
        if rule.retry_forced_tool_choice_on_400 is not None:
            retry_required = rule.retry_forced_tool_choice_on_400
    # Moonshot BYOK: sampling is fixed for current Kimi leaves; legacy
    # ``moonshot-v1*`` still accepts temperature → keep sending it.
    if base_url:
        preset = match_byok_provider_preset(base_url)
        if preset is not None and preset.id == "moonshot" and not leaf.startswith("moonshot-v1"):
            omit_temp = True
    return WireDialect(
        echo_reasoning_content=echo,
        thinking_type_switch=thinking,
        omit_temperature=omit_temp,
        retry_forced_tool_choice_on_400=retry_required,
    )
