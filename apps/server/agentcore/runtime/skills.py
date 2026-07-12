"""System Skills: code-defined capability docs the CEO pulls on demand (渐进披露).

提示词瘦身 P2 的落地。CEO 的常驻系统提示词只保留「决定干什么」的路由核心（见
``prompt._CEO_CORE_HINT``）；「怎么干」的进阶机制——团队编排进阶 / 辩论与交叉审查 /
定向唤回 / 向用户发问（开场提案卡 + 途中拍板）/ 委派波间挂起——下沉为 **系统 Skill**：代码定义、随 CEO 常备、以一
张「能力目录」常驻（仅一行触发描述），模型决定要用某能力后才用 ``consult_skill(name)``
把完整指引拉回自己的 ReAct 循环。

这是 ``docs/03-AI核心/工具与能力系统.md §二`` 已定的「Skill 渐进披露」机制（目录模式 +
按名拉取）的第一个实例。系统 Skill 与未来「市场 Skill」并列为两类来源，共用同一套
``SkillRegistry`` + ``consult_skill``（单一机制、多类来源）——正如内置工具与市场工具
共用 ``ToolRegistry``，不另造平行系统。

``requires_tools`` 把现有的 live-user 门（ask_user 仅在有活跃用户时装配）一般化：一个
Skill 只在它依赖的工具全部装配时才进目录，故提示词永不广告 CEO 手里没有的能力（沿用
现有不变量）。
"""

from __future__ import annotations

from dataclasses import dataclass

from agentcore.runtime.runs.playbooks import available_playbooks

# 拆·playbook 固化 (§2.1): the固化形状 listing embedded in the team-orchestration skill, sourced
# from the registry so the skill never drifts from the actual set / their summaries.
_PLAYBOOK_LISTING = available_playbooks()


@dataclass(frozen=True)
class SystemSkill:
    """One code-defined capability doc, surfaced in the catalog and pulled by consult.

    ``summary`` is the one-line trigger description shown in the always-on catalog
    (tells the model WHEN to pull it); ``body`` is the full HOW guidance, returned
    only when ``consult_skill(name)`` is called. ``requires_tools`` gates the
    catalog entry: the skill appears only when every named tool is wired this turn
    (e.g. the ``ask_user_*`` skills need the ``ask_user`` tool, which is live-user
    only), so the prompt never advertises a capability the CEO cannot act on.
    """

    name: str
    summary: str
    body: str
    requires_tools: tuple[str, ...] = ()


class SkillRegistry:
    """Name → :class:`SystemSkill` lookup (single source of truth, mirrors ToolRegistry)."""

    def __init__(self) -> None:
        self._skills: dict[str, SystemSkill] = {}

    def register(self, skill: SystemSkill) -> None:
        """Register a skill. Raises ValueError if the name is already registered."""
        if skill.name in self._skills:
            raise ValueError(f"Skill '{skill.name}' is already registered")
        self._skills[skill.name] = skill

    def get(self, name: str) -> SystemSkill | None:
        """Resolve a skill by name, or None if unknown (consult_skill degrades on miss)."""
        return self._skills.get(name)

    def list_all(self) -> list[SystemSkill]:
        """Every registered skill (registration order)."""
        return list(self._skills.values())

    def available(self, tool_names: set[str]) -> list[SystemSkill]:
        """Skills whose ``requires_tools`` are all wired — the catalog visibility filter."""
        return [
            skill
            for skill in self._skills.values()
            if all(tool in tool_names for tool in skill.requires_tools)
        ]


# --- System Skill bodies (the HOW guidance, moved out of the always-on prompt) ---
# Each was a CEO hint in runtime/resolve/prompt.py (P1); P2 externalises them so they ride
# the context only when the CEO consults them. Wording preserved so behavior is
# unchanged — only the delivery (always-on → on-demand) differs.

_TEAM_ORCHESTRATION_ADVANCED = """\
<team_orchestration_advanced>
进阶档位建立在一个前提上：你已确认需要多 worker。但多数任务一个 worker 端到端完成更高效——\
只有当并行 / 专业化收益明显超出协调成本时，才动用下面的进阶档位。先问自己：一个 coherent worker \
能做完吗？能就不拆。

按需用好 `delegate` 的进阶档位（不必都填）：

- 模型档位：范围清晰的简单子任务用 `model_preference="fast"` 省成本与时延；需深度推理\
或更高质量的用 `strong`（默认）。`reasoning_effort`（high/max）当前 MVP 仅解析存储、不下发 LLM，\
勿依赖其调节推理强度。
- 质量契约：对产出有硬性要求（须含某些小标题 / 关键词、限定格式或字数）时用 `deliverable` \
声明——未达标会带着具体差距自动返工一次；返工后仍不达标默认仅附质检提醒（软），\
`deliverable.strict=true` 则判该 worker 失败（硬退）。`deliverable.name` 描述想要的产出形态。
- 审查类任务的统一契约（派【审查 / 质检 / 评审】worker 时【必设 deliverable】）：无论并行扇出\
还是 `depends_on` 链下游，每个审查官 task 都必须带 `deliverable` 锁定统一输出格式——否则各审查官\
各说各的、打分维度各异，你收工时无法自动合并，`revise` 也无法字段级操作。推荐 JSON 模板\
（多路并行时各审查官 deliverable 完全一致，只换 role 与审查侧重；在 task 里写明该官负责的维度\
与打分锚点）：\
`deliverable: { "output_format": "json", "name": "JSON 对象，必含三顶层字段：problems（问题数组，每项含 severity/description/evidence）、\
suggestions（修改建议数组）、score（0–10 整数，该维度打分）。只输出 JSON，不要附带说明文字。" }`\
纯文字备选：`required_sections: ["问题", "建议", "评分"]`（优先 JSON，便于机械合并）。审查是中间\
产物、注入下游或供你汇总，不设 `requires_files`。
- 依赖流水线：多阶段（设计 → 实现 → 审查）用【同一次 `delegate`】里的 `depends_on` 串成\
依赖图——这些 worker 都在你下面【同一层】，上游产出自动注入下游；`depends_on` 只定先后、\
不加层级。DAG 模式下每个 task 必须显式声明 `depends_on`（即使为空列表 `[]`）。如果 task \
描述中提到「上游」「基于…产出」，必须对应 `depends_on` 引用。补跑/重试时同样必须写明完整 \
`depends_on`，不能依赖 `file_read` 代替依赖声明。用 `result_handling`（`pass_through` 全文 / \
`summarize` 摘要，默认全文）控制上游\
产物注入下游的保真度：大扇入的【并行调研 → 写作】链路里，若写作只需结论、不需逐字原文，\
把这些调研依赖设 `summarize` 省 token；要保金额 / 法条编号 / 代码原样时才留 `pass_through`。\
（注意：`result_handling` 只管【上游→下游】注入，不影响回到你手里的内容——后者由 task 措辞\
决定，见下「广度调查」。）
- 嵌套委派（lead 下放）：Worker 默认自带一层委派能力——你按【大模块】拆即可（典型：前端 / 后端 / \
数据各交一个 worker），具体再细分由 lead 上手后自己判断，不必逐个决定是否开委派。若你【已经清楚】\
细粒度拆法，直接在这一层拆细往往更高效（少一层 lead 整合往返），但不是硬性要求——不确定细拆时\
交成果级目标让 lead 边干边据证据调也行（它在自己子队上同样能 replan / 收口，和你在顶层一样）。\
判据是【这个区够不够大、够不够自成一摊】、不是流水线长度；最多再嵌套一层（单个 lead 最多带 \
4 个 sub-worker）、其子成员不能继续委派。几个扁平的并行小活（如查三个不相干话题）直接一次 \
`delegate` 扇出即可，别为它再套一层 lead——那是纯开销。
- 轻量直出：当只派【一个】worker、且这次委派就是整件事的最终交付时，设 `finalize=true`：\
该 worker 成功后其产出直接作为你的回复呈现，省掉一轮收尾。只在确定看到结果后无需再做\
别的事时才用；只要可能要据结果继续委派、或一次派了多个 worker，就别设。
- 协调模式（默认开）：派【≥2 个】worker 时默认进入协调——`delegate` 立即返回『团队已启动』，\
你边看边调（`update_synthesis` 渐进合成 / `cancel_worker` 中途终止 / `resolve_escalation` 仲裁\
阻塞升级）。**`resolve_escalation` 只在协调模式下可用**；单 worker 时阻塞升级直达用户，\
你无法（也不应尝试）用本工具裁决。只需经典阻塞等待（等全队完成再返回）时传 `coordinate=false`\
显式退出。单 worker、`finalize`、嵌套 lead 不进协调。
- 交付物落盘：当产出是用户要【打开 / 运行 / 编辑 / 保存 / 复用】的实质交付物——可运行代码 / \
网页 / 应用、脚本、配置，以及成篇的报告 / 分析稿 / 方案 / 文档（成篇文字交付写成 .md）——\
给该 task 设 `deliverable.requires_files=true`：worker 未调用 file_write 落盘即判未达标、自动\
返工，从结构上杜绝把整份内容粘在回复正文、工作区却空着。再在 task 里点明「产出物是文件，\
请用文件工具写进工作区」、必要时用 `deliverable.name` 写清期望文件，双保险。只有【中间产物】\
（要注入下游 worker、并非最终交付）才留作文字、不设此契约。
- 完成验收（`completion_criteria`）：用户要【安装 / 运行 / 打开软件、联调集成、跑通测试】才算交付的\
任务——设 `completion_criteria=code_verified`，引擎校验 worker 是否用 `code_execute` / `test_run`\
在工作区实际跑通；纯写文件 / 成篇文档 / 报告、只需阅读编辑不必启动进程的——`files_written`（常配合 \
`deliverable.requires_files` 确保落盘）。别混用：能跑才算完的活别只验「写了文件」。
- 桌面提醒（本地绑定）：用户可能已离开电脑、任务跑完需唤回时，worker 可用 `desktop_notify` 弹系统\
通知（每次需用户审批，勿滥发）；云端无桌面客户端时不可用。
- 约束 vs 方案（写 task 的根本分寸）：task 里交【需求与约束】——目标、硬指标、关键前提、\
验收底线；交付物的【专业方案】——章节结构与论证脉络、代码的模块划分与架构、页面布局——留给\
专家 worker 设计，那是你雇它的核心价值，除非用户已明确指定结构。别在 task 里替它把骨架列全，\
也别拿 `deliverable.required_sections` 当结构蓝图——它只兜「必须覆盖的少数验收要点」，不是替专家\
规定完整章节。自检：我在交需求，还是替 worker 把活设计完？对照一例（用户只说「写篇讲向量数据库的\
科普，约 1500 字」）：【正例·交需求】点明受众（初学者）、要覆盖的范围（是什么 / 解决什么 / 典型\
场景）、篇幅、.md 落盘，分几节、如何展开留给 worker；【反例·替它设计完】把「第一节定义、第二节\
原理、第三节选型对比…」的章节骨架列进 task——受众与范围是需求，章节顺序与论证脉络却是 worker 的\
专业活，这一步把写手降成了填字员。
- 广度调查也归团队（哪怕最终只回用户一段话）：当一个问题要横扫大量文件 / 来源才答得清（如「项目\
哪些功能没完善」「X 在代码里是怎么实现的」「对比这几个模块」），别自己逐个 file_read / grep 串着\
查——既慢，又把大量正文堆进你当前上下文。把调查按几个【独立角度】拆开（按模块 / 子系统 / 来源 / \
对比维度），【一次 `delegate`】并行派出调研 worker（它们同持检索工具）；在每个 task 里点明「回报\
【精炼结论 + 关键证据指引（文件:行 / 链接）】，不要回贴整段文件正文」——回到你手里的便是 N 份短\
摘要而非 N 份原文，你据此综述成给用户的答复。这类纯调查通常【无交付物、不必落盘】，别给它们设\
`deliverable.requires_files`；它和下一条「调研驱动的大型交付」的差别只在末端有没有成篇产物。
- 调研驱动的大型交付，让结构跟着证据走：对需大量调研的成篇交付（论文 / 研究报告 / 方案），别在\
调研回来前就把结构定死。把「定结构」做成证据驱动、可被用户把关的显式一步——并行调研 worker →\
（写作 worker 先据调研产出【提纲】，给该提纲步骤设 `checkpoint_after=true` 让用户改 / 批）→ 同一\
worker 据定稿提纲写全文，用 `depends_on` 串起。提纲由专家据证据产出、用户拍板，而非你在 task 里\
凭空先写好。仅用于这类研究级大活，简单交付别套。
- 晚绑定下游 + 波边界续跑（下游职责依证据再定，你自己拍）：当某个下游步骤【具体该做什么】必须看\
上游产出才能定——不只是结构、而是【职责本身】（典型：先调研，调研结果才决定下一步派谁、干什么），\
给该步设 `bind_after_deps=true`、role/task 先写占位即可；其全部上游跑完后、本步运行前，控制权会\
交回你（delegate 输出『计划已让出』、附上游产出），你据此用 `replan` 把该步定稿（`binds`）、必要\
时顺带操舵其它未跑步骤（`steers`），再续跑【同一张】计划；确无需继续则 `replan(stop=true)` 收口。\
与上一条 `checkpoint_after` 的分别：checkpoint_after 是【让用户把关】中途结果，bind_after_deps 是\
【你自己据证据再定下游职责】、不打扰用户。克制使用——只在『此刻写死下游 spec 很可能跑偏』时设；\
上游已定、下游此刻就能写清的步骤别设（徒增一次回合）。
- 固化形状（playbook）：少数高频形状已固化成可一键实例化的确定性骨架——设 `playbook` + \
`playbook_args` 即生成整支团队（与手写 tasks 二选一），免每次手搓。可用：""" + _PLAYBOOK_LISTING + """。\
开工前先对一下：本次的活是不是正好是这些形状之一？是就直接套（省去手搓、还自带依赖编排与便签墙\
对齐等最佳实践），别再一片片手搭；只有形态确实特殊时才手写 tasks。各形状的槽位见 `delegate` 的 \
playbook_args 参数说明。
- 团队便签墙（并行兄弟对齐）：同一批无 `depends_on`、同时开跑的 worker 共享一面便签墙（`post_note` / \
`read_notes` / `amend_note`）。**主 Agent 可在 `delegate` 上预置共识**：`seed_notes`（`[{kind,text}]` \
写入便签墙，首波并行 worker 开局即见）与 `team_brief`（回合级「团队共识」块注入每个 worker 开局上下文，\
跨多波 `delegate` 仍沿用直至覆盖）——brief 写总述、seed 钉关键决定，减少在各 task 里重复粘贴同一段背景。\
当你一次派出【多路并行审查 / 质检 / 多角度审同一份上游产物】时：\
① 每个审查 task 必设统一 `deliverable`（见上「审查类任务的统一契约」）；② 各 task 写清共享验收\
维度（受众 / 风格 / 方向底线），但不必给每个审查官复制粘贴同一大段背景——横向重大信号靠便签\
补齐；③ 在各 task 里明确要求：谁先发现【整体方向错了 / 致命问题 / 继续抠细节已无意义】，必须\
【立刻】`post_note`（kind=heads_up）广播一行警示，【再】写详细意见，免得并行队友还在无关细节上\
白费（简介流水线类任务尤甚）；④ `build_feature` 等 playbook 已把接口契约类决定写成「我定了」\
便签——手搓并行审查时照此照办。收工时读概览里的【团队便签】核对是否与各人产出一致。
</team_orchestration_advanced>"""

_DEBATE_AND_REVIEW = """\
<debate_and_review>
当问题需要【对抗性多视角思考】、而非各角度独立的并行调研时，用 `debate` 工具发起一场由主持人\
主持的结构化辩论：主持人逐轮设争议焦点、派各方交锋、判是否还在产生新论点、自适应决定轮数并自停，\
最后交回【决策简报 + 交锋叙事线】双产物。它与 `delegate` 的并行对比本质不同——`delegate` 各 worker \
各自产出、由你综合；`debate` 里各方【真正针锋相对地回应彼此】，并由主持人为你的决策负责到底\
（去水提炼各方最强论点、区分事实分歧与价值分歧、给出带置信度的倾向判断），而非把正反并排甩给你。

何时用 `debate`（而非 `delegate` 并行）：① 要做有优劣 / 对错的【决策】（选 A 还是 B、该不该做 X），\
各方会真正交锋反驳；② 要【压力测试】某个已有方案的稳健性（挖漏洞、失败场景）；③ 要【学懂】一个\
有争议话题的观点光谱。各角度独立、无需相互反驳的并行调研 / 多角度汇总仍用 `delegate`；无对立面的\
任务不要用 `debate`。

三形态（按问题性质选 `form`）：
- `debate` 正反辩论：两方对称攻防，做有对错的决策。sides=2（一正一反）。
- `red_team` 红队挑刺：压测一个方案——把【被审方案方】标 `is_subject=true`（承受单向攻击并回应\
修补），其余为红队。sides=被审方 + 1~N 红队。
- `roundtable` 多方圆桌：3+ 视角多边碰撞，探讨争议、铺满观点光谱。sides≥3。

你只需定【命题与参与方】：`motion` 放命题（用户原话或你提炼的争议命题）；`sides` 每方给 `key`\
（唯一英文短词，如 pro/con/red1，用于跨轮定位）、`name`（展示名：用简短的【立场 / 视角】名，\
各方【对称同风格】——甜党 / 咸党、正方 / 反方、经济学视角 / 工程视角；别一方用立场名、另一方用\
模型名「原生DeepSeek」，模型走单独的 `model` 字段 + 界面徽章；仅「比谁更聪明」类辩论才两方都用\
模型名）、`stance`（喂给该方辩手的立场 / 视角定位）。轮数与收敛【你和用户都不设】——主持人据交锋质量自调。\
`thorough=false`（单轮快速对碰，对**含圆桌在内的所有形态**生效）用于【用户只想轻量看看】：明说\
「快速对碰一下」，或意图明显轻量（如「测试下这个功能」「简单一点就好」「随便聊聊 / 看个大概」）\
——这类不该被强制跑满多轮、产出冗余的「修订 v2」；其余默认 `thorough=true`（圆桌多轮、正反/红队辩透）。

开辩前先对齐用户原意（提炼命题是把争议【磨锋利】，不是把用户已给的框【改窄或偷换】）：`motion` / \
`sides` 是你替用户框定这场辩论，两条铁律——① 忠于用户点名的【对立极】：ta 若已给出争议轴或具体两极\
（如「该加重【还是】减轻法定刑」），`sides` 必须如实覆盖 ta 点名的每一极（正方 = 加重、反方 = 减轻），\
不得悄悄砍掉一极、或把它偷换成更温和 / 不对题的立场（如把用户要的「减轻派」换成「审慎派 / 别急着\
加刑」）；你可补 ta 没想到的视角，但不能删改 ta 已框定的。② 关键指代模糊先澄清：若这场辩论【依赖】\
一个用户没说清的指代（如「最近很火的那个」却没点名是哪件事 / 哪个方案），别自挑一解就闷头开辩——\
先用 `ask_user` 确认「你指的是不是 XX？我理解你的命题是……（含你点名的每一极）」（见 ask_user_kickoff \
/ midtask）；仅当猜错只是小返工、能平滑纠偏时，才可按合理默认开辩、并在正文【标注一句】你采用的理解。

收尾：`debate` 非终结，双产物回到你手里（用户可在界面展开逐轮攻防与各方全文）。据简报用你自己的\
话向用户收尾：先给结论与建议，再点出仅剩需用户拍板的【价值 / 偏好之争】——这类 AI 判不了的分歧，\
正适合接着用 `ask_user` 把选择交给用户（见 ask_user_midtask）。
</debate_and_review>"""

_REVISING_A_PRODUCT = """\
<revising_a_product>
当用户看到某个 worker 的产物后，要求对【它】做小改 / 增补 / 调整，或让同一人接着干强相关
的新任务（例如「把风险那节展开」「换个更正式的语气」「接着实现方案 B」），且仍由原角色
带着现场来干最合适时，用 `delegate` 并在该 task 上设 `continue_from_run_id`（取自团队执行
结果里标注的 run_id）——原作者带着 ReAct 轨迹接着干，而不是从零另派看不到旧稿的新人。
task 正文写清续干指令（改哪里 / 新任务是什么）；可与 depends_on / deliverable 同用。

什么时候【不要】带现场续派，而改用冷委派（不设 continue_from_run_id）：要换一个角色来改、
原稿本身是失败的、要把多份产物合并了再改、或独立新任务（防上下文污染）。若续派提示找不
到该 run、已达唤回上限、或目标仍在进行中，也按同样方式改冷委派，必要时设 replaces_run_id
标接手。
</revising_a_product>"""

_ASK_USER_KICKOFF = """\
<ask_user_kickoff>
开场引导：用 `ask_user` 开一张「开工提案卡」。触发线索（命中即【默认先开卡】、别凭猜直接 delegate）：\
用户给的是【一句话级 / 笼统】的需求，且产物是网站 / 应用 / 海报 / 幻灯 / 报告 / 分析 / 文档 / 设计这类\
「有多种合理做法、做错要返工」的实质交付物——这类「能做、但关键决策还没说全」（用合理默认就能开工）的\
请求，不要追问一堵问题墙，而是用 ask_user 开卡来开场：在 `message` 里用你自己的口吻复述你理解的目标、\
说明你将按哪套起步计划开做，再把决策一次摊给用户——想省事的人一键开做（全用默认），想管的人就地调整。

开场白写在 `ask_user` 的 `message` 里（推荐）或正文里均可——引擎会自动把正文吸收进卡片，不会重复展示。

把决策按【影响力】分两档放进卡里，而不是按「是不是技术」来分：
- 进 `assumptions`（起步计划，安静的默认）：影响小、可逆、用户多半不关心的决策——技术栈 / 目录结构 / \
部署机制 / 命名约定等。你替用户定好，以「项 + 值」陈列让 ta 知情即可（只读）。
- 进 `questions`（重点问题，主动征询，最多 5 个）：真正值得用户拍板的少数高杠杆决策。【不限于意图 / \
品味，也包括影响大的技术选择】——例如要不要手机端响应式、要不要中英双语、以后要不要能自己改内容\
（带后台）、交互动效还是纯静态。开场的每个问题都【应预填 default 默认答案】，这样即便问 5 个，想省事\
的用户一键就全默认通过，不会变回那堵要手打的墙。
- 给 choice 的每个选项配一行 `detail`（这一项的权衡 / 代价），展示在选项下方，让用户不必\
读散文就看懂取舍；把你最建议的一项标 `recommended`（至多一个，仅「推荐」高亮、不替用户预选，\
预选仍由 default 定）。开场里 recommended 常与 default 同项，detail 让用户秒懂取舍。
- `style_options`：仅当产物是视觉类（网站 / 海报 / 幻灯…）时给出风格预设（如「深色科技 / 简约商务 / \
活泼明亮」）让用户选基调；非视觉类省略。

若是文件类产物，在 `message` 里讲明最终交付是工作区里可打开 / 运行的实打实文件（开工后由 worker 落盘），\
不是聊天里的一段文本。

判断「高影响还是低影响」的准绳：这个决策一旦选错，用户会不会明显不满意、甚至要推倒重来？会→提为重点\
问题；不会、且你有稳妥默认→放进起步计划默认掉。拿不准时宁可默认掉。
</ask_user_kickoff>"""

_ASK_USER_MIDTASK = """\
<ask_user_midtask>
执行途中拍板：当你在执行中途遇到一个【自己无法独自定夺、且选错代价高】的关键岔路时，用 ask_user 暂停\
并请用户拍板：典型如方案 A/B 抉择、执行不可逆操作（大量删除 / 覆盖）前确认、任务范围明显超出最初预期\
需用户重新授权。把决策点写进 `message`（现状 + 为何需要 ta 定夺），用 `questions` 给出具体岔路选项\
（通常一个问题即可，kind=choice + options；可同时多选才设 multiple=true，互斥的二选一/多选一保持单选）。\
途中的关键岔路通常【不预填 default】——就是要 ta 来选；但可给每个选项配一行 `detail`\
（A/B 各自的权衡 / 代价），并把你倾向的一项标 `recommended`：不替用户预选，却让 ta 一眼\
看到你的专业倾向、快速拍板。用户「提交」会带上 ta 勾选的选项与可选补充，回到\
你的循环；「停止」结束本回合。同样：发问的话只写进 `message`、正文在发问前留空（避免落库铺垫与恢复后\
的话粘连，详见 ask_user_kickoff）。

何时【不要】用 ask_user：
- 简单问答 / 闲聊 / 解释、或只靠检索就能答的——直接答，别出卡。
- 需求已经说得很全、没有值得确认的决策——直接 `delegate` 开干（顶多在回复里一句标注小假设）。
- 连用户到底想要什么都看不懂（意图本身不可解、连目标都复述不出）——先用一句普通文字问清意图，而不是出卡。
- 可自行决定的细节、能用合理默认值的小选择——别打断用户。

反过来，当你选择【不打断】而用合理默认值推进时，若这个假设并非无关紧要，就在回复里顺带一句标注（如\
「我在此处假设了 X，若不符请指正」），让用户能低成本纠偏——这比为每个小歧义停下来问更顺畅，也比闷头\
假设更稳妥。

【非阻塞发问 `blocking=false`】上面这条「标注一句」的结构化进阶：当你已有合理默认、但这个假设值得让\
用户看到并能直接纠偏（而非埋在正文里一句），又不值得为它冻住整个回合时，用 `ask_user(blocking=false)`\
——【必须】在 `assumptions` 或某个 `question.default` 里写明你将先采用的默认（不写则该调用会被拒，因为\
"非阻塞却不给默认"等于偷偷瞎猜），然后【立刻按默认继续把回合做完，绝不等待】。问题会作为一条不阻塞的\
提示呈现给用户，ta 若回复会作为新消息在后续轮次到达，你届时再据此调整。判准：猜错只是小返工 / 能平滑\
纠偏 → 非阻塞；猜错会让产物大面积作废 / 不可逆 → 仍用 `blocking=true` 暂停等答复。别拿它替代真正该阻塞\
的关键岔路，也别为能完全自行决定的小事用它（那只需正文标注一句）。

辩论 / 交叉审查跑完后，若要在对立结论之间取舍，正适合用 ask_user 把选择交给用户：在 `questions` 里给出\
「采纳正方 / 采纳反方 / 都要 / 补充论证」这类具体选项让 ta 拍板。
</ask_user_midtask>"""

_VERIFY_AND_FIX = """\
<verify_and_fix>
## 验证与修复工作流

完成代码改动后，按以下步骤验证：

1. 运行 test_run(scope="affected") 检查受影响的测试
2. 如果全部通过 → 正常完成交付
3. 如果有失败：
   a. 阅读失败用例的错误信息
   b. 用 file_read 查看失败测试和相关代码的上下文
   c. 用 str_replace 修复代码（注意：不要修改测试文件本身）
   d. 再次运行 test_run 验证修复
4. 最多重试 3 轮。如果 3 轮后仍有失败：
   - 在交付摘要中如实列出未通过的测试和可能原因
   - 标记为 degraded 完成（不阻塞交付）
5. 如果测试命令本身报错（非断言失败，如环境问题）→ escalate

关键纪律：
- 禁止修改测试文件来让测试通过
- 禁止删除或跳过失败的测试
- 同一个错误连续出现 2 轮且修复方案相同 → 停止重试，如实报告
</verify_and_fix>"""

_LONG_FORM_WRITING = """\
<long_form_writing>
## 长文分段写作

用户要产出超长单文档（报告、论文、长 README、多章节手册）时，不要指望一次 \
file_write 写完全文——分段落盘更稳、也更省上下文。

推荐编排：
1. 先与用户或自己确认大纲（章节标题 + 每节要点）；必要时 ask_user 拍板结构。
2. delegate 给写手 worker：第一节用 file_write 创建文件并写入首段；后续各节用 \
file_append 逐段追加到【同一文件】。
3. 多 worker 并行写不同章节时，各用【不同文件名或子目录】，避免并发写同一路径。
4. 收尾前 file_read 抽查首尾与目录衔接；需要改中间某段时用 str_replace，不要 \
file_write 覆盖全文。

纪律：
- 追加前确认 path 一致；每节 content 自行带好段落分隔（如 leading `\\n\\n`）。
- 单节仍过长时，再拆成多轮 file_append，不要硬塞万行单次调用。
</long_form_writing>"""

_DELEGATE_CHECKPOINT = """\
<delegate_checkpoint>
委派途中的波间挂起（checkpoint_after）：当你在【同一次 delegate 的多步流水线（用 depends_on 串成的 DAG）】\
里安排了一个高危 / 不可逆 / 范围可能跑偏的中间步骤，且希望它跑完后、运行其下游步骤之前先让用户把关时，\
给那个中间 task 设 `checkpoint_after=true`：该步完成后会自动暂停，把已完成步骤的产出与待运行的下游步骤\
一并展示给用户，由 ta 选「继续 / 调整 / 停止」——继续=照原计划跑下游；调整=ta 留一句指示，作为高优先级\
要求注入尚未运行的下游步骤再放行；停止=就地结束、不再跑下游。

这与 ask_user 不同：ask_user 是你在循环里【临场】决定要不要问；checkpoint_after 是你在【委派时预先声明】、\
由调度器在波间强制执行的结构挂起——正用于「单个 delegate 跨多步、你拿不到中途控制权」的场景。只在确实\
值得让用户在继续前把关的关键节点设；单步委派、或只给末步设都不会触发（其后已无下游可把关，那种取舍改用 \
ask_user_midtask）。克制使用，别给每个步骤都设。
</delegate_checkpoint>"""


# --- The system skills (single source of truth) -----------------------------
# Catalog summaries (the always-on one-line triggers) per the design (§4.4): sharp
# enough that the model knows WHEN to pull each, without spending the body on it.
_SYSTEM_SKILLS: tuple[SystemSkill, ...] = (
    SystemSkill(
        name="team_orchestration_advanced",
        summary="多 worker 并行 / 依赖流水线 / 模型档位 / 契约 / 嵌套委派 / 轻量直出的进阶用法",
        body=_TEAM_ORCHESTRATION_ADVANCED,
    ),
    SystemSkill(
        name="debate_and_review",
        summary=(
            "对需对抗性多视角思考的问题用 debate 工具发起结构化辩论（正反 / 红队挑刺 / "
            "多方圆桌）：主持人主持自适应多轮交锋，交回决策简报 + 交锋叙事线"
        ),
        body=_DEBATE_AND_REVIEW,
        requires_tools=("debate",),
    ),
    SystemSkill(
        name="revising_a_product",
        summary="带现场续派：唤回原作者改稿或接强相关新任务",
        body=_REVISING_A_PRODUCT,
    ),
    SystemSkill(
        name="ask_user_kickoff",
        summary=(
            "开场引导：对「能做但没说全」的产出类请求，用 ask_user 开「开工提案卡」按影响力"
            "分档预填默认（assumptions / questions / style_options），一键可开做"
        ),
        body=_ASK_USER_KICKOFF,
        requires_tools=("ask_user",),
    ),
    SystemSkill(
        name="ask_user_midtask",
        summary=(
            "执行途中遇到高代价岔路用 ask_user 暂停拍板；含「何时不打断（合理默认 + 标注一句）」、"
            "非阻塞发问 blocking=false、辩论收尾交用户取舍"
        ),
        body=_ASK_USER_MIDTASK,
        requires_tools=("ask_user",),
    ),
    # checkpoint_after is a delegate-DAG mechanism, but it pauses for USER review —
    # only meaningful with a live user. Gate it on ``ask_user`` (the live-user proxy,
    # same as the other ask_* skills) so it never advertises on the autonomous path,
    # exactly as it did when it rode the merged asking_the_user skill.
    SystemSkill(
        name="delegate_checkpoint",
        summary=(
            "委派多步流水线时给高危中间步设 checkpoint_after，在波边界暂停让用户把关"
            "「继续 / 调整 / 停止」"
        ),
        body=_DELEGATE_CHECKPOINT,
        requires_tools=("ask_user",),
    ),
    SystemSkill(
        name="verify_and_fix",
        summary="完成代码改动后验证并修复测试失败（test_run → 读上下文 → 修代码 → 重试）",
        body=_VERIFY_AND_FIX,
        # Gated on ``delegate``, not ``test_run``: this skill guides the DELEGATED dev
        # loop (a worker runs test_run + str_replace), and test_run is now a worker-only
        # code-execution tool (GRANTABLE), so it never appears in the CEO's tool set.
        # Since consult_skill is CEO-only, gating on the worker-only test_run would make
        # the skill un-advertisable (dead). ``delegate`` is the CEO's real precondition —
        # it can act on this guidance by delegating — mirroring long_form_writing.
        requires_tools=("delegate",),
    ),
    SystemSkill(
        name="long_form_writing",
        summary="超长单文档分段落盘：大纲优先，首段 file_write、后续 file_append 追加",
        body=_LONG_FORM_WRITING,
        requires_tools=("delegate",),
    ),
)


def build_system_skill_registry(*, include_legal: bool = False) -> SkillRegistry:
    """Register the platform's built-in (system) skills — the single source of truth.

    Mirrors ``build_builtin_registry`` for tools: code-defined, always available to
    the CEO via ``consult_skill``. Future market skills register into the SAME
    registry shape (单一机制、多类来源).

    ``include_legal`` opts the legal vertical's domain skills into the SAME registry
    (法律垂直 v0 stopgap, gated on ``settings.legal_vertical_enabled`` at the call site).
    Default off so generic deployments keep exactly the platform system skills — the
    legal pack is layered, not baked into the core set. Deferred import keeps the
    module graph free of a core→domain edge when the vertical is disabled.
    """
    registry = SkillRegistry()
    for skill in _SYSTEM_SKILLS:
        registry.register(skill)
    if include_legal:
        from agentcore.runtime.legal_skills import LEGAL_SKILLS

        for skill in LEGAL_SKILLS:
            registry.register(skill)
    return registry


def render_skill_directory(registry: SkillRegistry, tool_names: set[str]) -> str:
    """Render the always-on ``<能力目录>`` block listing the consultable skills.

    Only skills whose ``requires_tools`` are all wired this turn appear (so the
    catalog never advertises a capability the CEO cannot act on — same invariant as
    the live-user gate on ask_user). Each line is ``- name：summary`` —
    enough for the model to decide WHEN to pull the full guidance via
    ``consult_skill(name)``. Returns "" when nothing is available so the caller can
    append nothing.
    """
    skills = registry.available(tool_names)
    if not skills:
        return ""
    lines = [
        "<能力目录>",
        "下列进阶能力的完整指引未常驻；要用到时，先用 `consult_skill(name)` 把指引拉回来再执行"
        "（纯对话式回答自己答即可，无需 consult；但凡要交付实质产物，尤其涉及多文件 / 多角色、"
        "或拿不准该派几个 / 怎么扇出，先 consult `team_orchestration_advanced` 再决定团队形态）：",
    ]
    lines.extend(f"- {skill.name}：{skill.summary}" for skill in skills)
    lines.append("</能力目录>")
    return "\n".join(lines)
