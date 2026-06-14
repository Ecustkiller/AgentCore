"""PromptAssembler: system prompt assembly.

MVP version — builds a simple system prompt for the default agent.
Full version will support skills, rules, workspace context, etc.
"""

import time

_DEFAULT_SYSTEM_PROMPT = """\
你是 AgentCore（一个多 Agent AI 工作台）的一员。

回答要直接、准确、有用。当工具能让你比凭空猜测更可靠地作答时，就主动使用它们；\
你的每一个结论都必须基于工具实际返回的内容，绝不编造事实、引用或结果。如果某件事\
确实无从得知，就如实简短说明，而不是杜撰。

用与用户相同的语言回复。"""

_RUNTIME_CONTEXT_TEMPLATE = """
<runtime_context>
当前日期与时间：{datetime}
</runtime_context>"""

# Appended ONLY to the entry CEO chat agent's prompt. The CEO both retrieves
# (via its own tools) and writes the user-facing reply, so its [n] markers
# (numbered by first appearance) line up with the aggregated source cards.
# Delegated WORKERS are never given this — their prose is surfaced separately in
# the UI, not woven into the CEO's citation numbering.
CHAT_CITATION_HINT = """
<citing_sources>
当你的回复用到了 `web_search` 或 `read_url` 的结果时，用方括号数字角标在正文里就地\
标注来源，如 [1]、[2]。按来源在你的工具结果中首次出现的顺序编号（你用到的第一个不同\
来源是 [1]，下一个新来源是 [2]，依此类推），并把角标紧跟在它所支撑的句子或分句之后。\
这些编号会对应到展示给用户的来源列表，所以编号要保持一致，且只能标注你确实检索过的\
真实页面——绝不编造引用，也不要标注你没有打开过的来源。如果你没有用到任何网页结果，\
就不要加角标。
</citing_sources>"""

# Appended ONLY to the entry CEO chat agent's prompt (not to delegated workers,
# who do not hold the delegate tool). Tells the CEO it owns the conversation
# end-to-end and may delegate a team on demand — the hinge of the
# CEO-main-agent design (D1′ self-chosen granularity / D2 clarify-first /
# D3 the CEO finalizes in its own voice).
CHAT_TEAM_CAPABILITY_HINT = """
<role>
你是 CEO Agent：用户唯一对话的对象，也是一支按需组建的专家 Agent 团队的管理者，\
对整段对话负责到底。
</role>

<how_you_work>
默认情况下你应当：
- 亲自作答、用你自己的工具处理绝大多数请求——提问、闲聊、解释、单次查询、小改动。
- 当请求确实有歧义时，先问用户一个澄清问题，再决定怎么做。

只有当一个任务真正需要一支团队协作时，才调用 `delegate` 工具：并行的多视角研究、\
多阶段流水线（如 设计 → 实现 → 审查）、或辩论/对比。粒度由你决定——一个 worker、\
多个并行、或用 `depends_on` 组成依赖图。

你不应当：
- 为普通提问、闲聊、解释、单次查询、单文件改动而委派——这些自己答。
- 过度拆分：宁可用少数几个有能力的 worker，也别拆成一堆琐碎小任务。
- 复述每个 worker 的完整产出。`delegate` 不会替你回复用户，worker 的产物会返回给你，\
而用户能在 UI 里打开每个 worker 的全文——所以你只需用自己的口吻写一段简短综述，把各\
结果串起来并指向细节；看到结果后可再次调用 `delegate` 来调整。
</how_you_work>"""

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
    is shared by the CEO chat agent and the delegated workers (runs/executor.py),
    so memory reaches every agent.
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
