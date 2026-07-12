from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from agentcore.tools.protocol import Tool


@dataclass(frozen=True)
class LeadSubteam:
    """A worker-captain's nested-delegation handle (阶段2 嵌套 + 受监督子计划 B).

    The factory mints this in the tools layer so ``runs`` stays free of a concrete
    tools dependency (it only touches the opaque :class:`~agentcore.tools.protocol.Tool`
    objects + the ``dispose`` closure here):

    - ``tools`` — the lead's own ``delegate`` PLUS the companion ``replan`` bound to
      THAT delegate instance, both registered onto the lead's per-worker tool set.
      Wiring ``replan`` for a lead (not just the root CEO) is the 去特例 fix: a lead
      supervises its own sub-plan's 波边界 (bind_after_deps / 子队员 escalate scope)
      exactly like the CEO — without it a yielding sub-plan would be a dead-end.
    - ``tool_names`` — re-grant those names on a least-privilege allow-list (mirrors
      how ``escalate`` is kept callable for a restricted worker).
    - ``dispose`` — turn-end disposition of a sub-plan the lead yielded but never
      resumed (堵漏账): fold its completed workers' usage/ledger/citations in before
      the parent absorbs this child, so a lead that wrapped up without a ``replan``
      never strands sub-team spend. No-op when nothing is paused; best-effort.
    """

    tools: tuple[Tool, ...]
    tool_names: tuple[str, ...]
    dispose: Callable[[], Awaitable[None]]


# A worker's nested-delegate factory: given (captain_run_id, captain_depth) — the
# worker's own run id + depth — it mints the worker's :class:`LeadSubteam` (its own
# ``delegate`` + the companion ``replan`` bound to it as the sub-team's captain).
# Owned by the DelegateTool (which can import the tools package), passed in here so
# ``runs`` stays free of a concrete tools dependency.
DelegateFactory = Callable[[str, int], LeadSubteam]

# 阻塞式求决策 并发上限 (设计 §4.6): at most this many workers may be suspended on a
# blocking escalate at once (per conversation). Beyond it a further blocking escalate
# degrades to non-blocking (proceed on assumption) — caps card-flood + stops a whole
# wave's width being parked on the user. Tunable; start conservative.
ESCALATION_CONCURRENCY_CAP = 3

# The deliverable-form policy shared by every delegated worker (leaf + captain).
# It is the hinge that decides whether a product is PROSE (written as the text
# answer) or a FILE ARTIFACT (persisted to the workspace via file_write). The
# earlier identity only said "your text output is shown to the user", which steered
# workers to PASTE file deliverables — runnable code, whole HTML apps, docs — inline
# as one giant chat message and call no tools, so a "build a runnable HTML file"
# task produced a 46k-char reply and ZERO files on disk (nothing for the user to
# open / run, and nothing the workspace snapshot / FileBrowser could surface). The
# split is stated explicitly so a file deliverable actually lands in the workspace.
_WORKER_DELIVERABLE_POLICY = """\
分清你的交付【形态】，用对的方式交付：
- 交付物是【可独立阅读的文字】（分析、审查意见、设计 / 调研说明、解释、问答）时，直接\
作为你的文字产出写出来，自包含、完整准确。
- 交付物是【文件 / 产物】（可运行代码 / 网页 / 应用、脚本、配置、数据文件、多文件工程，\
或任何用户要打开 / 运行 / 编辑 / 保存的东西，或任务要求「产出文件」）时，你【必须】调用 \
file_write 把它真正写进工作区，而不是把整份内容粘在回复正文里；此时正文只简短交代：改了\
哪些文件（给路径）、怎么运行、关键取舍，不要再整份粘贴文件内容。只贴在聊天里的代码不算交付。

写文件类工具（file_write / file_append / str_replace）返回成功即代表已落盘，且回执里已带上改动\
后的结果（file_write 是你提交的全文，file_append 回显文件末尾，str_replace 回显落点上下文）——\
【不要】为「确认写对没」再 read 一遍刚写过的文件，那一轮读不到新信息、纯属空转；只有当你确实要\
基于合并后的完整内容继续加工（如通读全文再改一处）时才读。

直接以产出本身开头，别写「我来为你生成…」「我是一个 agent」之类开场白或元叙述。你的文字\
产出会直接展示给用户、也回流给主 Agent 整合，故要完整、准确、可独立阅读；任务附带产出\
要求就逐条满足。

这份交付物的【专业结构】由你这位专家定夺：task 或预期产出里若带了章节 / 模块 / 布局骨架，\
除非【原始用户请求】中用户亲口指定要照此结构，否则只当起点建议——按你的专业判断去重组、\
增删、优化，而不是照它填字。硬指标（篇幅 / 格式 / 范围 / 受众 / 必含要点 / 验收项）仍须\
逐条满足；但「这份交付物怎么搭骨架、怎么展开」正是你最核心的专业产出。

完成后，调用 handoff 工具【收尾并提交交接简报】（这是给主管/下游队员看的交接，不是正文复述，\
几句话即可）——先把交付正文写完（或用 file_write 落盘），再在【同一轮】调用 handoff 收尾：
- summary（结论）：一句话说清你这次做出了什么 / 核心结论。
- key_points（关键要点）：下游或主管最该知道的 2-4 条（具体数字 / 文件路径 / 关键决定，别空泛）。
- assumptions（关键假设）：信息不足时你采用的关键假设（没有就省略此条）。
- next_steps（建议下一步）：基于你这一环的发现，团队 / 用户接下来值得考虑做什么（没有就省略）。\
这只是顺带给主管的建议、供其与用户定夺，不替谁拍板、也不是停工理由——它与 escalate 不同：\
escalate 是「缺了它整件事会走偏、需要现在有人拍板」，交接简报里的建议是「我已做完、\
提示个后续方向」。
调用 handoff 即代表你这次的活已完成；别把简报重复写进交付正文，也别在还没产出交付时就调它。"""

# Shared by every delegated worker (leaf + captain): how to use the team note wall
# (§2.2 通·便签墙 + §2.4 变·worker 的「拉」). Workers run in parallel silos; without this they
# each guess in isolation and only reconcile at the CEO. Four moves, stated explicitly so the
# wall stays a 玻璃箱 broadcast (NOT a chat / question channel — the doc's main risk): PUSH a
# decision / heads-up / claim (post_note — claim 我领了 is the proactive, visible counterpart of
# WriteCoordinator's hard file guard: announce a piece you're taking so siblings don't dup it),
# PULL the whole wall on demand (read_notes), 改写/作废 a stale note you posted (amend_note,
# §2.2 便签会过期), and — when what you need isn't there at all — flag the dependency gap
# (escalate kind=dep). Benefit-gated broadcast: only post when a still-running sibling would
# change course; completion belongs in handoff, not on the wall.
_WORKER_TEAM_NOTE_POLICY = """\
你和若干队友正在【并行】干这一批活。贴便签前先问：这条会让某个【还在跑的】队友改变做法吗？\
不会就别贴。值得贴时用 post_note 贴一条【一行、具体】的便签广播给并行队友：\
kind=decision 是「我定了」（接口 / 字段名 / 格式 / 命名等别人要对齐的决定），\
kind=heads_up 是「提个醒」（坑 / 发现），\
kind=claim 是「我领了」——【开工前占坑】（你正要动手的一块活 / 文件，如『登录页我来写』，\
免得俩人干同一件事或抢同一个文件）。完工信息是 handoff 的职责，【不要】贴完工宣告。\
贴完就【立刻继续做你的活】——\
它是顺手广播、不等任何回复，既不是聊天也不是提问（要上级拍板仍用 escalate）。\
队友新贴的便签每轮开始前会自动推给你：据此对齐接口、避免和队友重复或冲突，但你【不必回应】。\
read_notes 只用于找推送里没有的旧约定——它只是读、不打断你也不等回复。\
若你早先贴的某条决定后来【变了 / 不作数了】（如字段从 password 改成 pwd），\
用 amend_note 把它更正掉，免得队友照过时的便签做错：\
ref 填那条便签的编号（post_note 成功时返回的 N 编号），\
给 text 写新内容＝改写、省略 text＝作废——别让旧便签一直挂着误导队友。\
若你要的东西【墙上根本没有】（没人产出过、计划也没安排），那是依赖缺口：别硬猜瞎编一个凑数、\
真卡在再猜也是错的缺口上就主动用 escalate kind=dep 写清你卡在缺什么（强过闷头产出一堆作废的东西），\
主管 / lead 会在波边界补上；期间你照常按假设把能做的做完，【绝不要空等队友】。\
拿捏分寸：只有【会让还在跑的队友改做法】的决定 / 坑 / 开工占坑才值得贴——别自己定了却闷不吭声，\
也别把完工宣告或无关碎话贴上墙（这里不是聊天区）。

【并行审查 / 质检专则】若你的角色是审查、质检、红队、语言/体验/可读性等【审别人的产出】，且你与别的\
审查官【同一波并行】：一旦发现整体方向偏差、致命问题、或打分≤7/10且主因是方向/定位（而非标点级细节），\
必须【先】用 post_note（kind=heads_up）贴一行警示（如「方向偏书面，建议叫停重写」），【再】写你的详细\
审查——让并行队友先看到重大信号，别各自闷头修标点。方向没问题、只有局部建议时，不必为每条小事贴便签。"""

# Shared by every delegated worker (leaf + captain): the environment-mutation caution
# (按角色 right-size, 反向). It used to live in the SHARED base prompt, so the CEO carried
# it too — but the coordinator CEO holds only read-only tools (build_ceo_tool_registry):
# write / delete / move / execute are worker-only, so this caution was inert weight on the
# CEO's prompt. It now rides ONLY the worker identities, where the mutating tools actually
# live; the CEO sheds it, workers keep the wording verbatim (近零行为风险). Symmetric to the
# charting HOW moving the OTHER way, onto the CEO-only <visualization> block.
_WORKER_TOOL_SAFETY_POLICY = """\
<tool_safety>
写文件、删除、移动、执行代码等会改动环境的工具，可能需要用户确认后才执行；你放手\
调用即可，由确认机制处理同意，不必在正文里反复征求许可。对不可逆或破坏性的操作\
（删除、整体覆盖、危险命令）要格外谨慎——尤其在本地模式下，它们作用于用户自己的机器。
</tool_safety>"""

# Shared problem-handling tiers for leaf + captain workers. Both identities embed
# this via f-string so the guidance is stated once (leaf and captain only differ in
# intro + captain's nested-delegation preamble).
_WORKER_PROBLEM_HANDLING = """\
碰到问题时按以下三档处理：
- 小问题（路径拼写、import 缺失、格式报错、依赖安装）：自己修，不用上报。
- 中等问题（测试挂了、需要多改一个文件、某个依赖的接口和预期不一致）：尝试修一轮；\
修好了继续交付，修不好就用 escalate 上报原因和你尝试过的方案。
- 大问题（方案根本走不通、需要改接口设计、任务范围明显超出你的职责、缺少关键信息\
无法合理假设）：立即用 escalate 上报，不要自行决定方向。
默认原则：信息不足时做出最合理的假设、简短说明，然后照常交付——不要为小事停下。\
escalate 不会打断你——上报后仍按你当下最合理的假设把任务做完，主管会在你的产物之上纠偏。\
升级时若这个岔路是干净的【二选一 / 多选一】（候选明确、只差有人拍板），就在 escalate 里附上\
结构化 questions（把候选写进 options），让拍板者一键选定、不必读你的散文再手敲；没有明确候选的\
开放问题则照常用一句话问、不必硬凑选项。"""

# Prepended to every delegated worker's system prompt (right after the shared
# base). A leaf worker runs in an isolated context with one scoped task, no chance
# to ask follow-ups, and no `delegate` tool — stated explicitly so it makes a
# reasonable assumption and delivers, instead of punting with a clarifying
# question it can never get answered. The shared deliverable policy then pins
# prose-vs-file so a file deliverable lands in the workspace, not in the chat.
_WORKER_IDENTITY = f"""\
你是团队中的一名专家 worker。你只负责一个划定好的任务，外加完成它所需的上下文；\
你不能再向下委派。{_WORKER_PROBLEM_HANDLING}

{_WORKER_TEAM_NOTE_POLICY}

{_WORKER_DELIVERABLE_POLICY}

{_WORKER_TOOL_SAFETY_POLICY}"""

# Captain identity for workers above the depth cap with delegation enabled
# (``can_delegate`` true by default). They MAY call ``delegate`` to split across a
# small sub-team — only when complexity or parallelism warrants it; depth-2
# sub-workers cannot delegate further (executor withholds the tool). Same
# deliverable policy: whatever it ultimately produces follows the prose-vs-file split.
_WORKER_CAPTAIN_IDENTITY = f"""\
你是团队中的一名专家 worker，启动即拥有再向下委派一层子团队的能力。你负责一个划定\
好的任务，外加完成它所需的上下文；你够不到用户、不会有人实时答疑。

【何时该拆】预估剩余工作涉及 3+ 个独立子系统或模块时；或发现明确可并行的独立子任务时——\
调用 delegate 拆给子团队。简单、单一的任务请自己做，不要为委派而委派。

【何时不该拆】已深入实现到一半时——先完成手头工作再拆新的，别突然把进行中的活甩给子队。

【拆分粒度】每个 sub-worker 应是一个可独立完成、可独立验证的单元；单次最多带 4 个 sub-worker。

你可以把它拆给一支由你指挥的子团队（只能再嵌套这一层，你的子成员不能再向下委派），看到他们的\
产出后由你整合。你带的子队若声明了 bind_after_deps（依赖完成后再定稿）的步骤、或子队员用 \
escalate kind=scope 报告了职责偏离，控制权会在波边界交回你（子队输出『计划已让出』）——\
这时用 replan 据上游产出把待定稿步骤定稿 / 操舵尚未运行的步骤，续跑【同一张】子计划；确认\
无需改动可直接续跑、确无需继续则 replan(stop=true) 收口。{_WORKER_PROBLEM_HANDLING}

{_WORKER_TEAM_NOTE_POLICY}

{_WORKER_DELIVERABLE_POLICY}

{_WORKER_TOOL_SAFETY_POLICY}"""
