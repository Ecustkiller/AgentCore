"""Memory / user-rules ``<rules>`` injection templates and formatters."""

from agentcore.memory.user_memory import strip_memory_chrome

# Unique owner for「记忆不得改路由」— both memory injection shapes format this in.
_MEMORY_ROUTING_FENCE = (
    "硬约束：长期记忆只约束沟通方式与已知事实；题材/领域偏好与历史任务不得改变本回合路由"
    "（直答/委派/调研/辩论以用户当前话为准）。"
)

_MEMORY_RULES_TEMPLATE = """
<rules>
以下是关于当前用户的长期记忆（由 AI 自动维护，属软性偏好）。请在不与用户当前
指令冲突的前提下遵循；如有冲突，以用户的显式指令为准。
{routing_fence}

{memory}
</rules>"""


def _format_memory_rules(memory_markdown: str | None) -> str | None:
    """Wrap the user's memory into a <rules> block, or None if empty.

    Injects only the substantive body: the file's human chrome (the title + the
    "可随时编辑/删除" note) is stripped (``strip_memory_chrome``) because the wrapper
    below already frames what this is to the model, and the note is addressed to the
    user — verbatim it's just mid-prompt noise.
    """
    if not memory_markdown or not memory_markdown.strip():
        return None
    body = strip_memory_chrome(memory_markdown)
    if not body:
        return None
    return _MEMORY_RULES_TEMPLATE.format(memory=body, routing_fence=_MEMORY_ROUTING_FENCE)


# Combined <rules> block when the user has their OWN rules (Agent记忆与知识系统 §二 / §5.7):
# user rules FIRST with authoritative wording (须遵守), AI memory AFTER with soft wording
# (软性偏好, 可被覆盖). Authority is carried by the WORDING, not a separate channel. When the
# user has no rules this template is NOT used — ``_format_memory_rules`` keeps the memory-only
# block byte-identical (prefix-cache + existing prompt tests unaffected).
_RULES_WITH_USER_TEMPLATE = """
<rules>
以下是本次对话须遵循的规则与长期记忆。权威性由措辞体现：用户规则为硬性约束，长期记忆为软性偏好。

【用户规则 · 须严格遵守】以下由用户本人设定、代表其明确意图，请务必遵守；仅当与用户在本回合的
直接指令冲突时，才以本回合的指令为准。
{user_rules}{memory_section}
</rules>"""

# Soft AI-memory half inside the combined block; fence text = ``_MEMORY_ROUTING_FENCE``.
_MEMORY_SUBSECTION_TEMPLATE = """

【长期记忆 · AI 维护的软性偏好】以下为 AI 依据以往对话总结的偏好与已知事实，属参考性软约束，
可被用户规则或本回合指令覆盖。
{routing_fence}
{memory}"""


def _format_rules_with_user(
    user_rules_markdown: str, memory_markdown: str | None
) -> str:
    """Compose the combined user-rules + AI-memory ``<rules>`` block (two-tier wording)."""
    user_body = user_rules_markdown.strip()
    memory_body = strip_memory_chrome(memory_markdown) if memory_markdown else ""
    memory_section = (
        _MEMORY_SUBSECTION_TEMPLATE.format(
            memory=memory_body, routing_fence=_MEMORY_ROUTING_FENCE
        )
        if memory_body
        else ""
    )
    return _RULES_WITH_USER_TEMPLATE.format(
        user_rules=user_body, memory_section=memory_section
    )


def _format_rules(
    memory_markdown: str | None, user_rules_markdown: str | None
) -> str | None:
    """Build the turn's ``<rules>`` block from user rules + AI memory (§二 two-tier).

    With no user rules this defers to ``_format_memory_rules`` so the memory-only block stays
    byte-identical to the prior assembly (load-bearing for prefix caching). With user rules it
    uses the combined template (authoritative user rules first, soft memory after).
    """
    if user_rules_markdown and user_rules_markdown.strip():
        return _format_rules_with_user(user_rules_markdown, memory_markdown)
    return _format_memory_rules(memory_markdown)
