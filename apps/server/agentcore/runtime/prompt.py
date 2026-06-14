"""PromptAssembler: system prompt assembly.

MVP version — builds a simple system prompt for the default agent.
Full version will support skills, rules, workspace context, etc.
"""

import time

_DEFAULT_SYSTEM_PROMPT = """\
You are AgentCore, a capable AI assistant.

Respond directly and helpfully. Use the available tools when they would help
answer the user's question more accurately. Think step by step for complex
problems.

When using tools, explain briefly what you're doing and why. After getting
tool results, synthesize them into a clear answer.

Always respond in the same language the user uses."""

_RUNTIME_CONTEXT_TEMPLATE = """
<runtime_context>
Current date and time: {datetime}
</runtime_context>"""

# Appended ONLY to the entry chat agent's prompt (not to team workers, who do not
# have the assemble_team tool). Tells the chat agent it owns the conversation and
# may escalate to a team on demand — the hinge of the chat-first design.
CHAT_TEAM_CAPABILITY_HINT = """
<team_capability>
You handle the vast majority of requests yourself: answer directly and stream \
your reply. Only when a request genuinely needs a TEAM of specialized agents \
collaborating — multiple perspectives in parallel, a multi-stage pipeline (e.g. \
design → implement → review), or debate/comparison — call the `assemble_team` \
tool with a clear, self-contained task description. The team plans, executes, \
and presents the final result to the user directly, so you must NOT repeat or \
re-summarize it afterward. Do NOT call `assemble_team` for ordinary questions, \
chat, explanations, single lookups, or single-file edits — just answer those \
yourself.
</team_capability>"""

_MEMORY_RULES_TEMPLATE = """
<rules>
以下是关于当前用户的长期记忆（由 AI 自动维护，属软性偏好）。请在不与用户当前
指令冲突的前提下遵循；如有冲突，以用户的显式指令为准。

{memory}
</rules>"""


def _format_memory_rules(memory_markdown: str | None) -> str | None:
    """Wrap the user's memory markdown into a <rules> block, or None if empty."""
    if not memory_markdown or not memory_markdown.strip():
        return None
    return _MEMORY_RULES_TEMPLATE.format(memory=memory_markdown.strip())


def assemble_system_prompt(
    *, memory_markdown: str | None = None, extra_context: str | None = None
) -> str:
    """Build the system prompt for a conversation.

    `memory_markdown` is the user's long-term memory file (see memory/store.py);
    when present it is injected as a soft-priority <rules> block. This base prompt
    is shared by the single-agent path and the multi-agent base (runs.py), so
    memory reaches every agent.
    """
    parts = [_DEFAULT_SYSTEM_PROMPT]

    parts.append(
        _RUNTIME_CONTEXT_TEMPLATE.format(
            datetime=time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime())
        )
    )

    rules = _format_memory_rules(memory_markdown)
    if rules:
        parts.append(rules)

    if extra_context:
        parts.append(extra_context)

    return "\n".join(parts)
