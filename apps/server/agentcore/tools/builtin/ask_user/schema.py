"""Card field normalization and caps for ask_user."""

from __future__ import annotations

from typing import Any

# Caps so a runaway prompt can't bloat the card / event. The free-form note on the
# card always lets the user steer beyond these.
_MAX_QUESTIONS = 5  # 开场重点问题最多 5 个（对齐 Cursor 2.1 的 3–5）
_MAX_OPTIONS = 6  # 每个 choice 问题的选项上限
_MAX_ASSUMPTIONS = 10
_MAX_STYLES = 6


def normalize_assumptions(raw: Any) -> list[dict[str, Any]]:
    """Cap + id the 起步计划 chips, dropping malformed / empty-label entries."""
    items = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for i, it in enumerate(items[:_MAX_ASSUMPTIONS]):
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()
        if not label:
            continue
        out.append({"id": f"a{i}", "label": label, "value": str(it.get("value") or "").strip()})
    return out


def normalize_questions(raw: Any) -> list[dict[str, Any]]:
    """Cap (≤5) + id the questions, normalizing kind/options/multiple/default.

    ``default`` is optional here (unlike the old kickoff): an opening question should
    pre-fill one, but a mid-task fork usually wants the user to actively choose, so it
    is left empty when the CEO omits it.
    """
    items = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for i, it in enumerate(items[:_MAX_QUESTIONS]):
        if not isinstance(it, dict):
            continue
        prompt = str(it.get("prompt") or "").strip()
        if not prompt:
            continue
        kind = "text" if str(it.get("kind") or "").strip() == "text" else "choice"
        if kind == "choice":
            options = [str(o).strip() for o in (it.get("options") or []) if str(o).strip()][
                :_MAX_OPTIONS
            ]
            multiple = bool(it.get("multiple") or False)
        else:
            options = []
            multiple = False
        out.append(
            {
                "id": f"q{i}",
                "prompt": prompt,
                "kind": kind,
                "options": options,
                "multiple": multiple,
                "default": str(it.get("default") or "").strip(),
            }
        )
    return out


def normalize_style_options(raw: Any) -> list[dict[str, Any]]:
    """Cap + id the 风格预设, accepting either ``{label}`` dicts or bare strings."""
    items = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for i, it in enumerate(items[:_MAX_STYLES]):
        raw_label = it.get("label") if isinstance(it, dict) else it
        label = str(raw_label or "").strip()
        if not label:
            continue
        out.append({"id": f"s{i}", "label": label})
    return out
