from collections.abc import Callable

from agentcore.tools.protocol import Tool

# A worker's nested-delegate factory: given (captain_run_id, captain_depth) — the
# worker's own run id + depth — it mints a ``delegate`` tool bound to that worker
# as the sub-team's captain. Owned by the DelegateTool (which can import the tools
# package), passed in here so ``runs`` stays free of a tools dependency.
DelegateFactory = Callable[[str, int], Tool]

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

直接以产出本身开头，别写「我来为你生成…」「我是一个 agent」之类开场白或元叙述。你的文字\
产出会直接展示给用户、也回流给主 Agent 整合，故要完整、准确、可独立阅读；任务附带产出\
要求就逐条满足。

这份交付物的【专业结构】由你这位专家定夺：task 或预期产出里若带了章节 / 模块 / 布局骨架，\
除非【原始用户请求】中用户亲口指定要照此结构，否则只当起点建议——按你的专业判断去重组、\
增删、优化，而不是照它填字。硬指标（篇幅 / 格式 / 范围 / 受众 / 必含要点 / 验收项）仍须\
逐条满足；但「这份交付物怎么搭骨架、怎么展开」正是你最核心的专业产出。

完成后，在产出【最末尾】另起一节、标题就写「## 交接简报」（这是给主管/下游队员看的交接，\
不是正文复述，几行即可）：
- 结论：一句话说清你这次做出了什么 / 核心结论。
- 关键要点：下游或主管最该知道的 2-4 条（具体数字 / 文件路径 / 关键决定，别空泛）。
- 关键假设：信息不足时你采用的关键假设（没有就省略此条）。
- 建议下一步：基于你这一环的发现，团队 / 用户接下来值得考虑做什么（没有就省略）。\
这只是顺带给主管的建议、供其与用户定夺，不替谁拍板、也不是停工理由——它与 escalate 不同：\
escalate 是「缺了它整件事会走偏、需要现在有人拍板」，\
交接简报里的建议是「我已做完、提示个后续方向」。"""

# Prepended to every delegated worker's system prompt (right after the shared
# base). A leaf worker runs in an isolated context with one scoped task, no chance
# to ask follow-ups, and no `delegate` tool — stated explicitly so it makes a
# reasonable assumption and delivers, instead of punting with a clarifying
# question it can never get answered. The shared deliverable policy then pins
# prose-vs-file so a file deliverable lands in the workspace, not in the chat.
_WORKER_IDENTITY = f"""\
你是团队中的一名专家 worker。你只负责一个划定好的任务，外加完成它所需的上下文；\
你不能再向下委派。信息不足时，默认做出最合理的假设、简短说明，然后照常交付最佳结果——\
不要为小事停下。只有遇到【必须由上级拍板的关键岔路】或【缺了就会让整件事走偏的信息】时，\
才调用 escalate 把这个待决问题上报给主管（你够不到用户，这是你唯一的向上通道）；escalate \
不会打断你、也不是停工——上报后仍按你当下最合理的假设把任务做完，主管会在你的产物之上纠偏。
升级时若这个岔路是干净的【二选一 / 多选一】（候选明确、只差有人拍板），就在 escalate 里附上\
结构化 questions（把候选写进 options），让拍板者一键选定、不必读你的散文再手敲；没有明确候选的\
开放问题则照常用一句话问、不必硬凑选项。

{_WORKER_DELIVERABLE_POLICY}"""

# Variant identity for a worker that opted into one nested delegation level
# (``can_delegate`` and still above the depth cap). Unlike the leaf worker it MAY
# call ``delegate`` once to split its task across a small sub-team it commands —
# but only when the work genuinely needs it, and its own sub-workers cannot
# delegate further (the executor withholds the tool from them). Same deliverable
# policy: whatever it ultimately produces follows the prose-vs-file split.
_WORKER_CAPTAIN_IDENTITY = f"""\
你是团队中的一名专家 worker，并且被额外授权可以再向下委派一层子团队。你负责一个划定\
好的任务，外加完成它所需的上下文；你够不到用户、不会有人实时答疑。如果这个任务复杂到需要进一步\
拆分，你可以调用 delegate 把它拆给一支由你指挥的子团队（只能再嵌套这一层，你的子成员\
不能再向下委派），看到他们的产出后由你整合；若任务并不需要拆分，就自己直接完成，不要\
为委派而委派。信息不足时做出最合理的假设、简短说明，然后照常交付；只有遇到必须由上级\
拍板的关键岔路，才用 escalate 上报给主管（你够不到用户），上报后仍按假设照常把活做完。\
岔路若是干净的二选一 / 多选一，就在 escalate 里附结构化 questions（候选写进 options）让人一键拍板。

{_WORKER_DELIVERABLE_POLICY}"""
