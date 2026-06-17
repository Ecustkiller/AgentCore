"""System Skills: code-defined capability docs the CEO pulls on demand (渐进披露).

提示词瘦身 P2 的落地。CEO 的常驻系统提示词只保留「决定干什么」的路由核心（见
``prompt._CEO_CORE_HINT``）；「怎么干」的进阶机制——团队编排进阶 / 辩论与交叉审查 /
定向唤回 / 向用户发问（开场引导 + 途中拍板）——下沉为 **系统 Skill**：代码定义、随 CEO 常备、以一
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


@dataclass(frozen=True)
class SystemSkill:
    """One code-defined capability doc, surfaced in the catalog and pulled by consult.

    ``summary`` is the one-line trigger description shown in the always-on catalog
    (tells the model WHEN to pull it); ``body`` is the full HOW guidance, returned
    only when ``consult_skill(name)`` is called. ``requires_tools`` gates the
    catalog entry: the skill appears only when every named tool is wired this turn
    (e.g. ``asking_the_user`` needs the ``ask_user`` tool, which is live-user
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
# Each was a CEO hint in runtime/prompt.py (P1); P2 externalises them so they ride
# the context only when the CEO consults them. Wording preserved so behavior is
# unchanged — only the delivery (always-on → on-demand) differs.

_TEAM_ORCHESTRATION_ADVANCED = """\
<team_orchestration_advanced>
按需用好 `delegate` 的进阶档位（不必都填）：

- 模型档位：范围清晰的简单子任务用 `model_preference="fast"` 省成本与时延；需深度推理\
或更高质量的用 `strong`（默认）。极复杂子任务可再设 `reasoning_effort="max"` 解锁更深推理。
- 质量契约：对产出有硬性要求（须含某些小标题 / 关键词、限定格式或字数）时用 `contract` \
声明——未达标会带着具体差距自动返工一次；返工后仍不达标默认仅附质检提醒（软），\
`contract.strict=true` 则判该 worker 失败（硬退）。用 `expected_output` 描述想要的产出形态。
- 依赖流水线：多阶段（设计 → 实现 → 审查）用【同一次 `delegate`】里的 `depends_on` 串成\
依赖图——这些 worker 都在你下面【同一层】，上游产出自动注入下游；`depends_on` 只定先后、\
不加层级。用 `result_handling`（`pass_through` 全文 / `summarize` 摘要，默认全文）控制上游\
产物注入下游的保真度。
- 嵌套委派：只有当某个 task 本身复杂到需自带一支小队时，才给它开 `can_delegate=true`\
（与流水线长度无关，最多再嵌套一层，其子成员不能继续委派，非必要不开）。
- 轻量直出：当只派【一个】worker、且这次委派就是整件事的最终交付时，设 `finalize=true`：\
该 worker 成功后其产出直接作为你的回复呈现，省掉一轮收尾。只在确定看到结果后无需再做\
别的事时才用；只要可能要据结果继续委派、或一次派了多个 worker，就别设。
- 交付物落盘：当产出是用户要【打开 / 运行 / 编辑 / 保存 / 复用】的实质交付物——可运行代码 / \
网页 / 应用、脚本、配置，以及成篇的报告 / 分析稿 / 方案 / 文档（成篇文字交付写成 .md）——\
给该 task 设 `contract.requires_files=true`：worker 未调用 file_write 落盘即判未达标、自动\
返工，从结构上杜绝把整份内容粘在回复正文、工作区却空着。再在 task 里点明「产出物是文件，\
请用文件工具写进工作区」、必要时用 `expected_output` 写清期望文件，双保险。只有【中间产物】\
（要注入下游 worker、并非最终交付）才留作文字、不设此契约。
- 约束 vs 方案（写 task 的根本分寸）：task 里交【需求与约束】——目标、硬指标、关键前提、\
验收底线；交付物的【专业方案】——章节结构与论证脉络、代码的模块划分与架构、页面布局——留给\
专家 worker 设计，那是你雇它的核心价值，除非用户已明确指定结构。别在 task 里替它把骨架列全，\
也别拿 `contract.required_sections` 当结构蓝图——它只兜「必须覆盖的少数验收要点」，不是替专家\
规定完整章节。自检：我在交需求，还是替 worker 把活设计完？
- 调研驱动的大型交付，让结构跟着证据走：对需大量调研的成篇交付（论文 / 研究报告 / 方案），别在\
调研回来前就把结构定死。把「定结构」做成证据驱动、可被用户把关的显式一步——并行调研 worker →\
（写作 worker 先据调研产出【提纲】，给该提纲步骤设 `checkpoint_after=true` 让用户改 / 批）→ 同一\
worker 据定稿提纲写全文，用 `depends_on` 串起。提纲由专家据证据产出、用户拍板，而非你在 task 里\
凭空先写好。仅用于这类研究级大活，简单交付别套。
</team_orchestration_advanced>"""

_DEBATE_AND_REVIEW = """\
<debate_and_review>
组织【辩论 / 交叉审查】（让多个 worker 就同一问题持对立立场、或互相审查）时：

- 单轮（多数场景够用）：给对立的 task 标 `stance`（`pro`=正方 / 支持，`con`=反方 / 反对），\
同一组对比用同一 `group` 把正反配对（仅一组可省）。这只是给前端的【呈现信号】，执行仍是\
普通并行；普通分工不要打 `stance`。
- 是否多轮：要做【真·多轮辩论】（正反轮流交锋、层层反驳）先掂量必要性——多数对比 / 审查用\
单轮 pro/con + 你综合就够，多轮只在确需层层反驳时才用、且克制轮数（通常 2-3 轮足矣）。
- 多轮配方：在单轮打标基础上 ① 给每个 task 标 `round`（从 1 起）；② 用跨轮 `depends_on` 让\
第 k 轮的一方依赖第 k-1 轮对方的产出（如 `pro_r2` 依赖 `con_r1`），使每轮都能针对性反驳；\
想辩几轮就一次把这些 task 都 `delegate` 出去。`round` 同样只是呈现信号。
- 收尾取舍：辩论 / 交叉审查跑完后若要在对立结论间取舍，正适合用 `ask_user` 把选择交给\
用户（见 asking_the_user），而不是你替 ta 决定。
</debate_and_review>"""

_REVISING_A_PRODUCT = """\
<revising_a_product>
当用户看到某个 worker 的产物后，要求对【它】做小改 / 增补 / 调整（例如「把风险那节展开」\
「换个更正式的语气」「再补一节测试用例」），且仍由原角色来改最合适时，调用 `revise` 唤回\
那个 worker：它会带着自己的现场记忆、在自己上一版产出的基础上继续修订，而不是从零另派一个\
看不到旧稿的新人重做（更快、更省，且不丢原有思路）。传入 `target_run_id`（要修订的那个产物\
的 run_id，取自团队执行结果里每个成员标注的 run_id）和 `feedback`（具体、可执行的修改意见）。\
修订结果会作为新的一版返回给你，由你照常收尾。

什么时候【不要】用 `revise`，而改用 `delegate` 带上旧产物重新委派：要换一个角色来改（如研究\
员的稿子交给工程师重写）、原稿本身是失败的、或要把多份产物合并了再改。若 `revise` 提示找不到\
该 run 或已达修订上限，也按同样方式改用 `delegate`。
</revising_a_product>"""

_ASKING_THE_USER = """\
<asking_the_user>
`ask_user` 是你唯一的「向用户发问」工具：默认【暂停本回合】、等用户回应后再继续（用户选\
「停止」则结束本回合）；也可设 `blocking=false` 做【非阻塞发问】——抛出问题但不暂停、你按\
既定默认继续（见下「非阻塞发问」）。开场引导与执行途中拍板【共用这一个工具】，只是内容详略不同。

发问的开场白只写进 `ask_user` 的 `message`（卡片顶部展示给用户）——【不要】在回复正文里再写\
一句引出问题的铺垫（尤其别用以「：」结尾、用来引出卡片内问题的话）。正文在发问前留空，待用户\
回应、你继续推进后再续写；否则落库历史里这句铺垫会与恢复后的话粘连成病句。

【一、开场引导】当用户的请求是【能做、但还没说全】的产出类任务（做网站 / 应用 / 海报 / \
文档 / 分析…，且用合理默认就能开工）时，不要追问一堵问题墙，而是用 ask_user 开一张「开工\
提案卡」来开场：在 `message` 里用你自己的口吻复述你理解的目标、说明你将按哪套起步计划开做，\
再把决策一次摊给用户——想省事的人一键开做（全用默认），想管的人就地调整。

把决策按【影响力】分两档放进卡里，而不是按「是不是技术」来分：
- 进 `assumptions`（起步计划，安静的默认）：影响小、可逆、用户多半不关心的决策——技术栈 / \
目录结构 / 部署机制 / 命名约定等。你替用户定好，以「项 + 值」陈列让 ta 知情即可（只读）。
- 进 `questions`（重点问题，主动征询，最多 5 个）：真正值得用户拍板的少数高杠杆决策。\
【不限于意图 / 品味，也包括影响大的技术选择】——例如要不要手机端响应式、要不要中英双语、\
以后要不要能自己改内容（带后台）、交互动效还是纯静态。开场的每个问题都【应预填 default \
默认答案】，这样即便问 5 个，想省事的用户一键就全默认通过，不会变回那堵要手打的墙。
- `style_options`：仅当产物是视觉类（网站 / 海报 / 幻灯…）时给出风格预设（如「深色科技 / \
简约商务 / 活泼明亮」）让用户选基调；非视觉类省略。

若是文件类产物，在 `message` 里讲明最终交付是工作区里可打开 / 运行的实打实文件（开工后由 \
worker 落盘），不是聊天里的一段文本。

判断「高影响还是低影响」的准绳：这个决策一旦选错，用户会不会明显不满意、甚至要推倒重来？\
会→提为重点问题；不会、且你有稳妥默认→放进起步计划默认掉。拿不准时宁可默认掉。

【二、执行途中拍板】当你在执行中途遇到一个【自己无法独自定夺、且选错代价高】的关键岔路时，\
同样用 ask_user 暂停并请用户拍板：典型如方案 A/B 抉择、执行不可逆操作（大量删除 / 覆盖）前\
确认、任务范围明显超出最初预期需用户重新授权。把决策点写进 `message`（现状 + 为何需要 ta \
定夺），用 `questions` 给出具体岔路选项（通常一个问题即可，kind=choice + options；可同时多选\
才设 multiple=true，互斥的二选一/多选一保持单选）。途中的关键岔路通常【不预填 default】——\
就是要 ta 来选。用户「提交」会带上 ta 勾选的选项与可选补充，回到你的循环；「停止」结束本回合。

何时【不要】用 ask_user：
- 简单问答 / 闲聊 / 解释、或只靠检索就能答的——直接答，别出卡。
- 需求已经说得很全、没有值得确认的决策——直接 `delegate` 开干（顶多在回复里一句标注小假设）。
- 连用户到底想要什么都看不懂（意图本身不可解、连目标都复述不出）——先用一句普通文字问清\
意图，而不是出卡。
- 可自行决定的细节、能用合理默认值的小选择——别打断用户。

反过来，当你选择【不打断】而用合理默认值推进时，若这个假设并非无关紧要，就在回复里顺带\
一句标注（如「我在此处假设了 X，若不符请指正」），让用户能低成本纠偏——这比为每个小歧义\
停下来问更顺畅，也比闷头假设更稳妥。

【非阻塞发问 `blocking=false`】上面这条「标注一句」的结构化进阶：当你已有合理默认、但这个\
假设值得让用户看到并能直接纠偏（而非埋在正文里一句），又不值得为它冻住整个回合时，用 \
`ask_user(blocking=false)`——【必须】在 `assumptions` 或某个 `question.default` 里写明你将\
先采用的默认（不写则该调用会被拒，因为"非阻塞却不给默认"等于偷偷瞎猜），然后【立刻按默认\
继续把回合做完，绝不等待】。问题会作为一条不阻塞的提示呈现给用户，ta 若回复会作为新消息\
在后续轮次到达，你届时再据此调整。判准：猜错只是小返工 / 能平滑纠偏 → 非阻塞；猜错会让产物\
大面积作废 / 不可逆 → 仍用 `blocking=true` 暂停等答复。别拿它替代真正该阻塞的关键岔路，\
也别为能完全自行决定的小事用它（那只需正文标注一句）。

辩论 / 交叉审查跑完后，若要在对立结论之间取舍，正适合用 ask_user 把选择交给用户：在 \
`questions` 里给出「采纳正方 / 采纳反方 / 都要 / 补充论证」这类具体选项让 ta 拍板。

【三、委派途中的波间挂起（另一机制 checkpoint_after）】当你在【同一次 delegate 的多步流水线\
（用 depends_on 串成的 DAG）】里安排了一个高危 / 不可逆 / 范围可能跑偏的中间步骤，且希望它\
跑完后、运行其下游步骤之前先让用户把关时，给那个中间 task 设 `checkpoint_after=true`：该步\
完成后会自动暂停，把已完成步骤的产出与待运行的下游步骤一并展示给用户，由 ta 选「继续 / 调整 \
/ 停止」——继续=照原计划跑下游；调整=ta 留一句指示，作为高优先级要求注入尚未运行的下游步骤\
再放行；停止=就地结束、不再跑下游。这与 ask_user 不同：ask_user 是你在循环里【临场】决定要\
不要问；checkpoint_after 是你在【委派时预先声明】、由调度器在波间强制执行的结构挂起——正用于\
「单个 delegate 跨多步、你拿不到中途控制权」的场景。只在确实值得让用户在继续前把关的关键\
节点设；单步委派、或只给末步设都不会触发（其后已无下游可把关，那种取舍改用 ask_user）。\
克制使用，别给每个步骤都设。
</asking_the_user>"""


# --- The 5 system skills (single source of truth) -----------------------------
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
        summary="组织辩论或交叉审查（含真·多轮交锋）",
        body=_DEBATE_AND_REVIEW,
    ),
    SystemSkill(
        name="revising_a_product",
        summary="定向唤回原作者，在其旧稿上修订某个已有产物",
        body=_REVISING_A_PRODUCT,
    ),
    SystemSkill(
        name="asking_the_user",
        summary=(
            "向用户发问（ask_user）：开场对「能做但没说全」的请求用提案卡按影响力分档引导，"
            "或执行途中高代价岔路拍板；含委派波间挂起把关（checkpoint_after）"
        ),
        body=_ASKING_THE_USER,
        requires_tools=("ask_user",),
    ),
)


def build_system_skill_registry() -> SkillRegistry:
    """Register the platform's built-in (system) skills — the single source of truth.

    Mirrors ``build_builtin_registry`` for tools: code-defined, always available to
    the CEO via ``consult_skill``. Future market skills register into the SAME
    registry shape (单一机制、多类来源).
    """
    registry = SkillRegistry()
    for skill in _SYSTEM_SKILLS:
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
