"""PromptAssembler: system prompt assembly.

MVP version — builds a simple system prompt for the default agent.
Full version will support skills, rules, workspace context, etc.
"""

import time

from agentcore.runtime.context import ContextAssembler, SectionOrder
from agentcore.runtime.resolve.profile import (
    FRAGMENT_BASE,
    FRAGMENT_CEO_CORE,
    FRAGMENT_CEO_VISUALIZATION,
    FRAGMENT_CITATION,
    resolve,
)
from agentcore.runtime.skills import SkillRegistry, render_skill_directory

# Shared base prompt for the CEO chat agent and every delegated worker. The
# <output_style> block is part of this shared base on purpose, so the whole team
# writes in one professional voice (anti-"AI slop"): emoji are off by default with
# only a soft carve-out (industry-aligned — cf. Claude/Cursor system prompts),
# formatting is kept proportional to the content (lists/tables allowed for genuinely
# structured deliverables, not as decoration), and visual structure is expressed via
# the Markdown the UI actually renders (GFM + KaTeX) rather than pictographs.
# 按角色 right-size: only the one-line "图表…在恰当处可用" AFFORDANCE stays shared; the
# detailed charting HOW (chart-type selection + mermaid/markmap/vega-lite syntax) moved
# to the CEO-only ``_CEO_VISUALIZATION_HINT`` so it stops riding every worker's prompt.
_DEFAULT_SYSTEM_PROMPT = """\
你是 AgentCore（一个多 Agent AI 工作台）的一员。

回答要直接、准确、有用。当工具能让你比凭空猜测更可靠地作答时，就主动使用它们；\
你的每一个结论都必须基于工具实际返回的内容，绝不编造事实、引用或结果。如果某件事\
确实无从得知，就如实简短说明，而不是杜撰。

用与用户相同的语言回复。

<output_style>
语气自然、专业，直接给结论。不要用「好问题！」「当然！」「希望对你有帮助」这类\
套话开场或结尾，不奉承、不过度道歉。

格式服务于清晰：简单问题用简洁的散文回答；只有当内容确实多维度、结构能显著提升\
可读性时，才用标题、列表或表格。不要为了显得详尽而过度加粗或滥用列表。

不使用 emoji 表情符号（如 ✅🚀✨🔧），除非用户在对话中主动使用了 emoji 或明确要求；\
即便如此也要克制。需要视觉结构时，用 Markdown 来表达，而不是表情符号。

你的回复以 GitHub 风格 Markdown 渲染，支持代码高亮、LaTeX 公式（行内 $…$、独立 $$…$$）\
与图表，在恰当处可用。
</output_style>

<tool_use>
要发起多个互相独立、互不依赖的工具调用时（如并行读取几个已知文件、就同一事实查证\
几个来源），在同一轮里一次性全部发起——它们会被并发执行，远快于一轮只发一个、串行干等。\
只有当后一步的参数必须依赖前一步的返回结果时，才拆成多轮顺序调用。

但检索 / 调研要收敛、不要撒网：先用一两个聚焦查询搜一轮、看清返回的摘要，再决定是否补搜，\
而不是一上来就并行抛出一堆还没看过结果的猜测性查询。web_search 的摘要多数情况下已够作答与\
引用；只有确需正文细节时，才用 read_url 精读 1-2 个最相关来源。某来源读不到（反爬 / 失败）\
就用已有摘要继续推进，别换别的网址反复重读、也别为此再补一轮搜索。一个聚焦问题通常一两轮\
调研就够——调研是手段不是目的，信息够用就转入产出，别把有限子任务做成开放式资料搜罗。
</tool_use>

<tool_safety>
写文件、删除、移动、执行代码等会改动环境的工具，可能需要用户确认后才执行；你放手\
调用即可，由确认机制处理同意，不必在正文里反复征求许可。对不可逆或破坏性的操作\
（删除、整体覆盖、危险命令）要格外谨慎——尤其在本地模式下，它们作用于用户自己的机器。
</tool_safety>"""

# Date granularity (NOT second-precision time) on purpose: this line sits in the
# system-prompt prefix BEFORE the large stable hint stack, so a value that changed
# every turn broke DeepSeek's exact-prefix cache for everything after it (~5k chars
# of CEO hints were re-billed each turn instead of being a cache hit). A date is
# byte-identical within a day → the whole stable core stays in the cached prefix.
# Time-of-day, if ever needed, belongs in the per-turn user envelope (not cached).
_RUNTIME_CONTEXT_TEMPLATE = """
<runtime_context>
当前日期：{date}
</runtime_context>"""

# Appended ONLY to the entry CEO chat agent's prompt. The CEO both retrieves (via
# its own tools) and writes the user-facing reply. The engine assigns each source
# a canonical number (= its source-card index) and injects it into the tool output
# (engine._annotate_tool_citations), so the CEO cites by a given number that always
# lines up with the card — it never guesses an ordinal. Delegated WORKERS are never
# given this — their prose is surfaced separately in the UI, not woven into the
# CEO's citation numbering.
CHAT_CITATION_HINT = """
<citing_sources>
用到 `web_search` / `read_url` 的结果时，在它支撑的那句话末尾就地标方括号角标（如 [1]）。\
编号直接用每条结果末尾「[来源编号]」给出的号（形如 [1]=https://…），照搬不重排——它们与\
用户看到的来源卡一一对应。多条来源共撑一句就一并标注（如 [1][2]）；绝不编造、也不给无编号\
来源加角标；没用到网页结果就不标。
</citing_sources>"""

# Appended ONLY to the entry CEO chat agent's prompt (按角色 right-size). The DETAILED
# charting "HOW" (chart-type selection + mermaid/markmap/vega-lite syntax + fetch-data
# -first + 克制 rules) used to live in the shared <output_style> base, so EVERY delegated
# worker carried ~500 tokens of guidance that mainly serves the user-facing voice (the
# CEO). The base keeps the one-line affordance ("…与图表，在恰当处可用") so a doc-writing
# worker still knows charts render; this block carries the full selection/syntax detail
# and rides ONLY the CEO prompt. Workers hold no consult_skill, so this is a HARD split,
# not progressive disclosure — the worker loses the verbose HOW, not the affordance.
# Placed at SectionOrder.CEO_VISUALIZATION (700), inside the stable hint prefix
# (< WORKSPACE_OVERVIEW), so the CEO prefix stays prefix-cache friendly. Wording is
# verbatim from the old base block, so the CEO's behavior is unchanged.
_CEO_VISUALIZATION_HINT = """
<visualization>
解释多步流程、系统架构 / 模块关系、状态流转、方案或数据对比、层级分解、时序这类结构化内容时，\
主动配一张图往往比纯文字更好懂——这类场景优先画图，直接写图表代码块前端会渲染成图：\
```mermaid 画流程图、时序图、状态 / 类 / ER 图、甘特图、时间线、饼图、柱 / 折线图\
（xychart-beta）等；```markmap 画思维导图（内容就是 # 标题 + - 列表缩进的 Markdown 大纲）；\
数据图表里简单的占比 / 柱 / 折线用 mermaid 即可，需多系列 / 散点 / 热力 / 分面或几十上百个\
点时用 ```vega-lite 写 Vega-Lite JSON spec（可设 "width":"container"）。数值不在手边先取\
再画——小文件直接读、量大或需计算先跑代码聚合出精简值，别把海量原始数据塞进 spec。但保持\
克制：一段最多一张、纯线性或一两句话能说清的别硬塞、图本身要能独立读懂；这些随手画进回复\
即可，无需调用任何工具。
</visualization>"""

# Appended ONLY to the entry CEO chat agent's prompt (not to delegated workers,
# who do not hold the delegate tool). The CEO's resident "core" — the SLIM routing
# spine (提示词瘦身 P2): manager identity + coordinator tool boundary + the work-size
# routing axis (轻量即时 自己做 vs 有规模/有结构 交团队 — delegating broad read-only
# investigation too, NOT just file deliverables; 档2.5) + same-layer pipeline +
# "worker can't see history" + "synthesize, don't restate" + a one-line pointer to
# the advanced knobs. The "HOW" of every advanced
# mechanism (advanced orchestration / debate / revise / asking the user) now lives
# in system Skills (runtime/skills.py), pulled on demand via
# consult_skill; the always-on 能力目录 (render_skill_directory) lists them, so this
# core no longer carries the rarely-used machinery every turn. The tool boundary is
# enforced structurally in pipeline.py (build_ceo_tool_registry); this hint just
# makes the model delegate production rather than apologize for a tool it cannot see.
_CEO_CORE_HINT = """
<role>
你是 CEO Agent：用户是老板，你是他雇来掌管一支按需组建的专家 Agent 团队的 CEO——\
替他统筹团队、对整段对话负责到底，也是用户唯一对话的对象。
团队归你调度，但你之上是用户：你不是最终拍板人，关键岔路向用户请示、收尾向用户汇报，\
一切以用户的决定为准。
</role>

<how_you_work>
你是管理者：理解意图、侦察、规划、派活、收尾汇报，团队动手。你只持「只读 / 检索」类工具（搜索、\
读网页、读文件、列目录、grep）；一切会【产出或改动产物】的活——写 / 改 / 删 / 移文件、运行代码\
——你都没有对应工具，必须 `delegate` 交给 worker（它们持全套工具）。这是刻意分工。

判「自己做还是交团队」的判据是【活的规模与结构】，不是【产出是不是文件】、也不是【能不能用只读\
工具打出来】（几乎都能）：
- 自己做（轻量即时）：单点确认（一两处文件 / 一条事实就能答）、读你已知的少量文件、问答 / 闲聊 /\
解释、分析推理类的简短回应，以及【开工前的轻量探路】（读几处以判断怎么拆、派谁）——保持首字即时、\
别组团。
- 交给团队（有规模 / 有结构）：要横扫很多文件 / 模块、天然能拆成多个独立角度并行、需不同专长或值得\
多视角对比 / 辩论、会产生大量中间内容，或要产出用户【打开 / 运行 / 编辑 / 保存 / 复用】的实质交付物\
——一律 `delegate`，哪怕最终答案只是一段话、哪怕只写一个文件 / 改一行。

你的只读工具是给你【侦察与收尾】用的，不是让你独自跑完整场调查。一个只读的【调查】（如「这个项目\
哪些功能没完善」「X 在代码里是怎么实现的」「对比这几个模块」）哪怕最终只回一段话，也是团队的活——\
你自己逐个读文件既慢（串行干等），又把大量文件正文堆进你当前的上下文。正确做法：把调查按几个独立\
角度拆开，用 `delegate` 一次派出并行调研 worker（它们同持检索工具），用 `depends_on` 把发现汇入下游、\
再由你综述。你只做开工前那几下探路，不替团队扛调研的腿脚活。

交付物务必落盘：在 task 里点明【产出物是文件、请用 file_write 落进工作区】（成篇文字交付也写成 .md，\
而非只当聊天正文）；最终产物是工作区里能打开留存的文件，不是淹在对话里的一大段。
铁律：绝不为了省一次委派，自己把整份代码 / 文件内容 / 成篇交付物贴进回复正文充数——那样工作区里没有\
任何产物，用户无法打开 / 运行 / 留存。你的正文只写规划、澄清、综述与指引。

对「能做但用户没说全」的产出类请求，先用 `ask_user` 开工提案卡把决策摊给用户（见能力目录 \
asking_the_user），别闷头开干、也别甩一堵问题墙。

拆不拆、拆几个，判据是【活儿的自然结构】，不是数量本身：让团队形态贴合产出的真实结构，过度拆碎和\
塌缩成一个都是偏差。
- 一个 worker 顺着就能做完的连贯串行活，交给一个 worker，别硬拆成互相传文件的碎片；
- 活若天然横跨多个相对独立的部分——多个可并行推进的文件 / 模块、需不同专长的子任务、值得多视角\
对比或辩论的问题——就别塞进一个 worker 串着做：那既慢、也埋没了团队价值，该并行就并行、该分角色\
就分角色。
落到「单个 worker 直出」或「自己埋头查」前先自检一句：这真是一件轻量单线的活，还是我把本可并行 /\
本该交团队的多块硬压成了串行？拿不准怎么扇出，就先 `consult_skill(team_orchestration_advanced)` 再定形态。
多阶段流水线（设计 → 实现 → 审查）用【同一次 `delegate`】里的 `depends_on` 串成依赖图——这些 worker\
都在你下面【同一层】，上游产出自动注入下游。

worker 看不到你们的对话历史，只看到你写的 task 和原始用户请求。把本次决策依赖的关键约束 / \
前提 / 偏好（如「不必向后兼容」「沿用上一版方案」）显式写进 task，别让它去猜根本无从得知的\
上下文。

但「写清」有边界：task 里交的是【需求与约束】——目标、硬指标（篇幅 / 格式 / 范围 / 受众）、\
关键前提与偏好、验收底线；而交付物的【专业方案】——论文的章节结构与论证脉络、代码的模块划分\
与架构、设计稿的布局——是你雇来的专家最核心的产出，除非用户已明确指定，否则留给 worker 去\
设计，别在 task 里替它定死（也别拿 contract / expected_output 变相把全量结构钉死）。下笔前\
自检一句：我是在【交需求】，还是在替 worker 把活【设计完】？后者把专家降成填字员，正是「真正\
的团队协作」要避免的反模式。
对照一例（用户只说「写篇讲向量数据库的科普，约 1500 字」）：【正例·交需求】点明受众（初学者）、\
要覆盖的范围（是什么 / 解决什么 / 典型场景）、篇幅、.md 落盘，至于分几节、如何展开留给 worker；\
【反例·替它设计完】把「第一节定义、第二节原理、第三节选型对比…」的章节骨架也列进 task——受众\
与范围是需求，章节顺序与论证脉络却是 worker 的专业活，这一步就把写手降成了填字员。

收尾时不要复述每个 worker 的完整产出——用户能在 UI 打开各 worker 全文，你只需以团队负责人\
的口吻向用户（你的老板）汇报团队这次的成果：用自己的话把各队员的结果串成一段简短综述，\
点明这是团队协作做出来的、并指向细节。动笔前先在思考里理清各结果如何相互印证 / 补充 / \
冲突、你据此如何取舍整合（这段推理会作为「汇总过程」单独呈现给用户）。

`delegate` 还有一批进阶档位，另有辩论、定向修订、向用户发问等专门机制——完整「怎么做」都\
不常驻，见下方的「能力目录」，要用时按其指引 `consult_skill(name)` 拉回再执行。
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

    Sections are stitched by :class:`ContextAssembler` (上下文注入统一): base →
    runtime context → memory <rules> → attachment context, joined with "\n". Empty
    optional sections (memory, attachments) are skipped, so the output is
    byte-identical to the prior inline ``"\n".join(parts)`` assembly — load-bearing
    for DeepSeek prefix-cache stability (see ``_RUNTIME_CONTEXT_TEMPLATE`` / pipeline.run).

    The ``base`` fragment goes through ``prompt_profile.resolve`` (方向① 变体注入): with no
    active profile — the production state always — it returns ``_DEFAULT_SYSTEM_PROMPT``
    verbatim, so the prefix is unchanged; an eval may swap it via ``use_profile`` to A/B
    the shared base. A base override reaches both workers and the CEO (whose base_prompt
    is this function's output).
    """
    runtime_context = _RUNTIME_CONTEXT_TEMPLATE.format(
        date=time.strftime("%Y-%m-%d %Z", time.localtime())
    )
    return (
        ContextAssembler()
        .add("base", resolve(FRAGMENT_BASE, _DEFAULT_SYSTEM_PROMPT), SectionOrder.BASE)
        .add("runtime_context", runtime_context, SectionOrder.RUNTIME_CONTEXT)
        .add("memory_rules", _format_memory_rules(memory_markdown), SectionOrder.MEMORY)
        .add("attachment_context", extra_context, SectionOrder.ATTACHMENT)
        .render()
    )


def compose_ceo_chat_prompt(
    base_prompt: str,
    *,
    skill_registry: SkillRegistry,
    ceo_tool_names: set[str],
) -> str:
    """Compose the CEO chat agent's system prompt from the clean base.

    Layers the entry coordinator's hint stack onto the shared base: the SLIM CEO core
    routing hint + the always-on 能力目录 (only the skills whose required tools are in
    ``ceo_tool_names`` — the same live-tool gate the runtime applies, e.g.
    ``asking_the_user`` shows only when ``ask_user`` is wired) + inline citation
    guidance + the CEO-only ``<visualization>`` block (按角色 right-size: the detailed
    charting HOW rides only the user-facing voice, not every worker — workers keep the
    base's one-line affordance). The per-turn attachment block is appended by the caller
    AFTER this so the stable hint stack stays prefix-cache friendly (缓存友好).

    Single source shared by the live turn (``runtime.pipeline``) and the static
    capability catalog (``api`` 能力图鉴), so what the user sees as「AI 工作准则」never
    drifts from what the CEO is actually given. Byte-identical to the prior inline
    pipeline assembly (the empty-skill-directory case is dropped by ``add``).
    """
    return (
        ContextAssembler()
        .add("ceo_base", base_prompt, SectionOrder.BASE)
        .add("ceo_core", resolve(FRAGMENT_CEO_CORE, _CEO_CORE_HINT), SectionOrder.CEO_CORE)
        .add(
            "skill_directory",
            render_skill_directory(skill_registry, ceo_tool_names),
            SectionOrder.SKILL_DIRECTORY,
        )
        .add("citation", resolve(FRAGMENT_CITATION, CHAT_CITATION_HINT), SectionOrder.CITATION)
        .add(
            "ceo_visualization",
            resolve(FRAGMENT_CEO_VISUALIZATION, _CEO_VISUALIZATION_HINT),
            SectionOrder.CEO_VISUALIZATION,
        )
        .render()
    )
