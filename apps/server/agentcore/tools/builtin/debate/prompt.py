"""辩手 prompt 构造（首轮 task + 后续轮 feedback）。"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agentcore.runtime.debate import (
    DebateConfig,
    DebateForm,
    DebateSeed,
    DebateSide,
    RoundResult,
    UserInterjection,
)
from agentcore.runtime.runs.types import ContextBlock
from agentcore.tools.builtin.debate.schema import (
    CLOSING_LENGTH_HINT,
    DEBATER_TOOLS,
    FORM_LABELS,
    LENGTH_HINT,
    QUICK_DEBATER_HINT,
)

# 后续轮把【对手上一轮发言】喂回本辩手时，每份的头尾截断上限。多方圆桌每轮要塞 N-1 份对手
# 全文，不裁会让 prompt 暴涨、烧钱且稀释焦点（主持人侧 judge/brief 早已 _clip，唯独喂辩手没裁）。
# 头尾保留：对手的立论（头）与结论（尾）都留，只挖中段——辩手看要旨足以针对性回应。
_OPP_CLIP = 1500


def _clip(text: str, limit: int = _OPP_CLIP) -> str:
    """头尾保留地截断（与主持人 ``moderator._clip`` 同思路）。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    half = max(1, (limit - 20) // 2)
    return f"{text[:half]}\n……（中段略）……\n{text[-half:]}"


# 举证责任·证据状态铁律（辩论编排设计.md §4-2.3 契约② P3，方案 A 内联标记）。放进辩手
# 【系统提示】而非每轮 task：辩手跨轮走 continue_run 复用同一 session（系统提示只发一次却全程生效），
# 故立论 / 续论 / 质询作答一律受此约束，无需逐条 prompt 重复注入（省 token、口径单一）。前端
# `remarkEvidence` 与裁判记分读同一套标记（`【已核实·<出处>】` / `【待核实·推断】`），三处咬合：
# 辩手标 → 裁判据标记记分/罚 → 前端把标记渲成证据徽章。开发期取证层常失败（read_url fake-IP，见 本地开发.md 排障）时本铁律让辩论【诚实标待核实】而非自信臆造，是对 P0 的正交护栏。
EVIDENCE_RULE = (
    "\n【举证责任·证据状态铁律】你陈述的每一条【关键事实主张】（具体数字 / 金额 / 日期 / 案号 / "
    "引用 / 先例 / 统计口径）都必须【紧跟一个证据状态标记】，二选一：\n"
    "- 【已核实·<出处>】——你确实用 web_search / read_url 查到了出处（标出来源，如「已核实·2024年报」）；\n"
    "- 【待核实·推断】——你拿不出出处，只是推断 / 常识 / 估算。\n"
    "拿不出出处就【诚实标注待核实】，绝不臆造具体来源、绝不把推断伪装成已核实事实；未加标记的关键事实"
    "一律按【待核实】对待。无据主张与「拿待核实当已成立的论据」会在质询里被当面追问、在记分里被扣分——"
    "诚实标注待核实【不扣分】，硬拗成事实才扣。"
)


# 查询构造铁律（会话 7e1baca0 复盘：辩手 web_search 查询过窄→空手）。与 EVIDENCE_RULE 一同进辩手
# 【系统提示】（只发一次、跨轮 continue_run 全程生效），治的是复盘实测出的取证主因：辩手在质询轮
# 被逼核实具体事实（案号 / 「17 件」）时，把 web_search 查询写成 6–8 个关键词硬拼的长句（如
# 「茉莉奶白 四叶花卉 商标申请 驳回 国家知识产权局 案号 LV 近似」）→ 健康引擎也返 0 结果 → 回落
# 「无法核实」。对照实测：短查询「茉莉奶白 LV 商标侵权」经同一后端 39 条 / 1.8s。这是【改查询写法】、
# 不是给辩手取证限次 / 降并发（§二已否决那类节流），不削独立取证、不改契约、不触补丁绊线。
SEARCH_QUERY_RULE = (
    "\n【web_search 查询铁律】搜索引擎按【少量核心词】匹配，不是自然语言问答——查询写太长 / 太具体会"
    "【命中率骤降、经常 0 结果】。故：\n"
    "- 每次 web_search 只用【2–4 个核心词】（主体 + 主题），别把一句话或 5+ 个限定词硬拼成一条 query；"
    "先用最核心的词搜到相关页面，再从结果里读细节，而不是一上来就把案号 / 机构 / 年份 / 金额全塞进去；\n"
    "- 核实某个具体数字 / 案号 / 金额时，用【主体 + 该事实的类别词】去搜（如查赔偿额搜「茉莉奶白 LV 判赔」），"
    "而不是把数字本身塞进 query；\n"
    "- 若返回【空结果】，别当成「不存在」——【删掉最具体的那个限定词（案号 / 机构名 / 年份 / 金额）再搜一次】、"
    "改用更泛或同义的词；连搜两次仍空，才按【证据状态铁律】诚实标【待核实·推断】。"
)


def role_directive(config: DebateConfig, side: DebateSide) -> str:
    """按形态 / 角色给辩手的差异化指引。"""
    if config.form is DebateForm.RED_TEAM:
        if side.is_subject:
            return (
                "（你是被审视的方案方：红队会单向施压找你的漏洞，你的职责是诚实回应、能修补"
                "就给出修补、修不了的风险要坦白承认，不要嘴硬。）"
            )
        return (
            "（你是红队：职责是尽力挖出该方案的风险、漏洞、失败场景与边界条件，单向施压，"
            "不需要你自己另提方案。）"
        )
    if config.form is DebateForm.ROUNDTABLE:
        return (
            "（这是多方圆桌：你代表一个特定视角，平等陈述并回应他人，目标是铺满观点光谱、"
            "贡献你这一视角独有的洞察，而非压倒对方。）"
        )
    return "（这是正反辩论：直接攻防，针锋相对地回应对方最强论点。）"


def side_system(config: DebateConfig, side: DebateSide) -> str:
    base = (
        f"你是一场结构化辩论中的辩手，代表「{side.name}」。坚定但理性地为你的立场辩护："
        "论据具体、直面对方、不偷换概念、不因篇幅长而堆砌；用具体证据 / 例子 / 推理链支撑论点，"
        "而非泛泛断言或空喊口号。"
    )
    return f"{base}{role_directive(config, side)}{EVIDENCE_RULE}{SEARCH_QUERY_RULE}"


def seed_block(seed: DebateSeed | None, side: DebateSide) -> str:
    """续辩（结构化补轮·B）首轮辩手的「上一场摘要」块——让本方读懂上一场后【接着往深里辩】。

    只喂【事实性的过程摘要】（逐轮焦点/小结 + 本方上一场最强论点 + 仍未决的分歧 + 争议焦点），
    **刻意不喂主持人的倾向判断 leaning**（那是裁判口径，喂给辩手会污染新一场的中立性）。无种子
    返回空串（首轮 task 不变、逐字回退到全新辩论）。"""
    if seed is None:
        return ""
    parts: list[str] = []
    if seed.rounds:
        arc = "\n".join(
            f"- 第 {r.round_no} 轮 · {r.focus}：{r.summary}" for r in seed.rounds if r.focus or r.summary
        )
        if arc:
            parts.append(f"上一场各轮交锋：\n{arc}")
    mine = seed.strongest_points.get(side.key, "")
    if mine:
        parts.append(f"你（{side.name}）上一场最强论点：{mine}")
    if seed.crux:
        parts.append(f"上一场争议焦点：{seed.crux}")
    unresolved = list(seed.value_disputes) + list(seed.open_questions)
    if unresolved:
        parts.append("上一场仍【未决】的分歧（本场请往这些上面推进）：\n" + "\n".join(f"- {u}" for u in unresolved))
    if not parts:
        return ""
    body = "\n\n".join(parts)
    return (
        "\n\n【这是续辩——接着上一场辩论往深里辩】\n"
        f"{body}\n"
        "请在上一场的基础上提出【新的】论点或更深一层的论证，别重复上一场已说透的内容。\n"
    )


def debater_task(
    config: DebateConfig,
    side: DebateSide,
    idx: int,
    *,
    round_no: int,
    focus: str,
    seed: DebateSeed | None = None,
) -> dict[str, Any]:
    """构造首轮单个辩手的 task dict（build_run_plan 入参）。

    ``seed`` 非空时（结构化补轮·B）注入上一场摘要块，让本方从「读懂上一场」处接着辩。"""
    # 快速对碰：注入轻量约束压住「为小题深挖」（少检索、收窄论点）；认真辩透则不加。
    quick_suffix = "" if config.policy.thorough else f"\n{QUICK_DEBATER_HINT}"
    prior = seed_block(seed, side)
    task = (
        f"你在一场【{FORM_LABELS.get(config.form, '辩论')}】中代表「{side.name}」。\n"
        f"辩论命题：{config.motion}\n"
        f"你的立场 / 视角：{side.stance}\n"
        f"本轮议题：{focus}\n\n"
        f"{role_directive(config, side)}{prior}\n"
        f"请就本轮议题给出有力、具体、有论据的论证（这是你的开场立论）：聚焦你最能站住的论点，"
        f"用具体证据 / 例子 / 推理链支撑（必要时用 web_search / read_url 取证）；关键事实主张按"
        f"【证据状态铁律】标注【已核实·出处】/【待核实·推断】。{LENGTH_HINT}{quick_suffix}"
    )
    payload: dict[str, Any] = {
        "role": side.name,
        "task": task,
        "objective": f"代表「{side.name}」就「{focus}」立论",
        "system_prompt_supplement": side_system(config, side),
        "model_preference": config.model_preference,
        "tools": list(DEBATER_TOOLS),
        "group": f"debate:{config.form.value}",
        "round": round_no,
    }
    # 真·多模型辩手（Phase 3）：side.model 仍解析入库，但 MVP 全链路统一用户 model，
    # per-side override 在 debater_task 中忽略（开放主流AI模型接入 §4.7）。
    # if side.model:
    #     payload["model"] = side.model
    # stance 仅正反 2 方有意义（builder 只认 pro/con，display-only）。
    if config.form is DebateForm.DEBATE and len(config.sides) == 2:
        payload["stance"] = "pro" if idx == 0 else "con"
    return payload


def _challenged_lines(config: DebateConfig, side: DebateSide, last_round: RoundResult) -> str:
    """本方上一轮被反驳的命门（``to_key==本方`` 的 clash 边）渲染成「- {反驳方}：{命门}」多行；
    无指向本方的边时返回空串。喂 LLM 的 :func:`_challenged_block` 与展示用的
    :func:`round_context_blocks` 都读它，保证「投喂==展示」同源。"""
    names = {s.key: s.name for s in config.sides}
    against = [c for c in last_round.verdict.clashes if c.to_key == side.key]
    return "\n".join(f"- {names.get(c.from_key, c.from_key)}：{c.point}" for c in against)


def _challenged_block(config: DebateConfig, side: DebateSide, last_round: RoundResult) -> str:
    """上一轮裁判抽出的「谁驳了本方、驳在哪」（``to_key==本方`` 的 clash 边）——喂回辩手让它
    【精准回应被攻击的命门】（B2）。与主持人侧 clash 强化形成正反馈：辩手正面接招 → 下一轮交锋
    更针锋相对 → 裁判抽 clash 更干净。无指向本方的边时返回空串（跳过、不硬塞）。"""
    lines = _challenged_lines(config, side, last_round)
    if not lines:
        return ""
    return (
        "\n\n上一轮裁判记录你被这样反驳（请【优先正面回应】这些命门——能驳回就驳回、"
        f"该让步就坦诚让步，别回避）：\n{lines}"
    )


def _interjection_mine(
    side: DebateSide, interjections: Sequence[UserInterjection]
) -> list[UserInterjection]:
    """本辩手本轮该正面回答的用户追问：定向本方（``target_key==本方``）的 + 未定向（空 target）
    的全场追问。喂 LLM 的 :func:`_interjection_block` 与展示用的 :func:`round_context_blocks`
    都读它，保证「投喂==展示」同源。"""
    return [i for i in interjections if i.ask and (not i.target_key or i.target_key == side.key)]


def _interjection_block(side: DebateSide, interjections: Sequence[UserInterjection]) -> str:
    """把用户【追问】拼进本辩手的 feedback —— 定向某方（``target_key``）的只喂给那一方，未定向
    （空 target）的喂给全场。追问是用户的最高优先级诉求，故明令【本轮优先正面回答】（先答追问、
    再展开），别答非所问。无（指向本方的）追问返回空串（feedback 不变、零行为变化）。"""
    mine = _interjection_mine(side, interjections)
    if not mine:
        return ""
    directed = any(i.target_key == side.key for i in mine)
    who = "向你" if directed else "向全场"
    lines = "\n".join(f"- {i.ask}" for i in mine)
    return (
        f"\n\n⚠️ 用户在本轮追问（{who}提出，请【本轮优先正面回答】，先答这个、再展开你的论点，"
        f"别回避、别答非所问）：\n{lines}"
    )


def round_feedback(
    config: DebateConfig,
    side: DebateSide,
    round_no: int,
    focus: str,
    last_round: RoundResult,
    interjections: Sequence[UserInterjection] = (),
) -> str:
    """后续轮喂给 continue_run 的 feedback：本轮焦点 + 用户追问（如有）+ 对方上轮论点（裁剪）+
    上轮被驳命门 + 「只补新论点、勿重述」约束。

    辩手在【自己的 transcript】上续写（已带自己上轮全文），故无需也不应重述自己上轮——明令
    「只补本轮焦点下的新论点 / 新回应」根治冗余轮的「修订 v2 内容相似」（与 ``_frame`` 的焦点
    正交约束一上一下夹击：换维度提问 + 只答新东西）。对手发言【头尾裁剪】（:func:`_clip`）防多方
    圆桌 prompt 暴涨；并把上轮裁判指向本方的 clash 命门喂回，驱动精准接招（见 :func:`_challenged_block`）。
    ``interjections`` 是用户在上一轮边界注入、本轮须正面回应的【追问】（交互式逐轮，opt-in；定向
    本方或全场的才喂给本辩手）——置于焦点之后、最高优先级（见 :func:`_interjection_block`）。"""
    opponents = [t for t in last_round.ok_turns if t.side_key != side.key]
    if opponents:
        opp_block = "\n\n".join(f"### {t.side_name}\n{_clip(t.content)}" for t in opponents)
    else:
        opp_block = "（对方上一轮无有效发言）"
    challenged = _challenged_block(config, side, last_round)
    ask_block = _interjection_block(side, interjections)
    # 圆桌不强求对立：把「针对性回应」软化为「回应并补充」，贴合 role_directive 的圆桌语义。
    if config.form is DebateForm.ROUNDTABLE:
        engage = "请【回应并补充】（呼应有道理的、标出你视角下的分歧、贡献你这一视角独有的洞察）"
    else:
        engage = "请【针对性回应】（驳斥站不住的、承认确有道理的、推进你的立场）"
    return (
        f"## 第 {round_no} 轮 · 本轮焦点：{focus}\n"
        f"{role_directive(config, side)}{ask_block}\n\n"
        f"对方上一轮的论点如下，{engage}：\n"
        f"{opp_block}{challenged}\n\n"
        f"直接输出你本轮的【完整发言】：**只补本轮焦点下的新论点 / 新回应**，用具体证据 / 例子 / "
        f"推理链支撑（必要时用 web_search / read_url 取证）；关键事实主张按【证据状态铁律】标注"
        f"【已核实·出处】/【待核实·推断】；不要重述你上一轮已说过的内容、"
        f"不要复述对方原话、不要罗列改动清单。{LENGTH_HINT}"
    )


def cx_answer_feedback(
    config: DebateConfig,
    side: DebateSide,
    round_no: int,
    focus: str,
    questions: Sequence[str],
) -> str:
    """质询环节（质询回合 P1）喂给 continue_run 的 feedback：主持人代表交锋向本方发出的必答质询。

    要求辩手输出**结构化 JSON 数组**（逐条对应、自评是否正面回应）；每条 ``answer`` 内仍可用自然语言
    论证（先「是 / 否 / 部分成立」表态、再用证据或推理支撑）。涉及具体事实的前提按【证据状态铁律】标注
    `【已核实·出处】`/`【待核实·推断】`（举证责任 P3，全文口径见 :data:`EVIDENCE_RULE`）；不得回避 /
    答非所问 / 复述已说过的立论——``directly_addressed: false`` 或回避会在裁判 engagement 记分被扣。
    辩手在自己的 transcript 上作答，故答复进入本方跨轮记忆、下一轮立论可见。"""
    n = len(questions)
    numbered = "\n".join(f"{i}. {q}" for i, q in enumerate(questions, start=1))
    return (
        f"## 第 {round_no} 轮 · 质询环节（本轮焦点：{focus}）\n"
        f"{role_directive(config, side)}\n\n"
        "主持人代表交锋，向你发出以下【必须正面回答】的质询。请逐条作答，并**只输出一个 JSON 数组**"
        f"（共 {n} 条，与下方编号一一对应；不要 markdown 代码块外的解释文字）：\n"
        "[\n"
        '  {"question_index": 1, "answer": "对该条的正面回答（可用自然语言论证）", '
        '"directly_addressed": true},\n'
        '  {"question_index": 2, "answer": "...", "directly_addressed": false}\n'
        "]\n\n"
        "字段说明：\n"
        "- question_index：与下方质询编号一致（从 1 起）\n"
        "- answer：对该条的正面回答——先用「是 / 否 / 部分成立」明确表态，再用具体证据或推理支撑；"
        "凡涉及具体事实的前提都按【证据状态铁律】标注【已核实·出处】/【待核实·推断】，拿不出出处就诚实标"
        "【待核实·推断】、别含糊带过或硬拗成已核实\n"
        "- directly_addressed：你是否正面回应了该条（true/false；回避、答非所问、重复已说过的立论标 false）\n\n"
        f"质询列表（共 {n} 条）：\n{numbered}"
    )


def round_context_blocks(
    config: DebateConfig,
    side: DebateSide,
    round_no: int,
    focus: str,
    last_round: RoundResult,
    interjections: Sequence[UserInterjection] = (),
) -> list[ContextBlock]:
    """后续轮 continue_run 的【收到的上下文】展示投影（上下文传递可视化）。

    与 :func:`round_feedback`（渲染给 LLM 吃的字符串）**从同一批输入孪生构造**——本轮焦点 /
    用户追问 / 对方上一轮论点(每方一段·头尾裁剪) / 上一轮被驳命门。二者共享 :func:`_clip` /
    :func:`_interjection_mine` / :func:`_challenged_lines` 这几个内容源，避开「拼给 LLM」与
    「展示给用户」双源漂移（补丁绊线：同一份事实只算一次）。``continue_run`` 把这批 block 作为
    ``run_context`` 事件抛出，前端修订节点的「任务/收到的上下文」据此渲染（辩论 v2+ 面板不再空白
    也不再显示首轮通用任务）。"""
    blocks: list[ContextBlock] = [
        ContextBlock(channel="round_focus", heading=f"第 {round_no} 轮 · 本轮焦点", body=focus)
    ]
    mine = _interjection_mine(side, interjections)
    if mine:
        directed = any(i.target_key == side.key for i in mine)
        who = "向你" if directed else "向全场"
        blocks.append(
            ContextBlock(
                channel="interjection",
                heading=f"用户本轮追问（{who}提出 · 最高优先级）",
                body="\n".join(f"- {i.ask}" for i in mine),
            )
        )
    opponents = [t for t in last_round.ok_turns if t.side_key != side.key]
    if opponents:
        for t in opponents:
            over = len(t.content.strip()) > _OPP_CLIP
            blocks.append(
                ContextBlock(
                    channel="opponent",
                    heading=f"对方上一轮 · {t.side_name}",
                    body=_clip(t.content),
                    source_role=t.side_name,
                    source_run_id=t.run_id,
                    fidelity="summarize" if over else "",
                    truncated=over,
                )
            )
    else:
        blocks.append(
            ContextBlock(channel="opponent", heading="对方上一轮", body="（对方上一轮无有效发言）")
        )
    challenged = _challenged_lines(config, side, last_round)
    if challenged:
        blocks.append(
            ContextBlock(channel="challenge", heading="上一轮你被反驳的命门", body=challenged)
        )
    return blocks


# 结辩环节喂给辩手的定调（阶段化发言角色 P4）：与 closing_task 从同一句意图孪生，供 run_context 展示。
_CLOSING_CONTEXT_BODY = (
    "本场辩论已充分交锋，主持人请你做【结辩陈词】：只讲胜负手（本方最强 1–2 点 + 为何对方最关键的"
    "反驳不成立），不得引入任何新论据 / 新事实 / 新案例，短而有力地收束。"
)


def closing_task(config: DebateConfig, side: DebateSide) -> str:
    """结辩环节（阶段化发言角色 P4）喂给 continue_run 的 feedback：辩已辩尽，请本方做【结辩陈词】。

    这是最后陈词、不是新一轮立论——要求辩手【只讲胜负手】：本方最强的 1–2 个论点为何站得住 + 对方针对
    你最关键的那条反驳为何不成立 / 已被回应。【不得引入任何新论据 / 新事实 / 新案例】、不复述全文、不逐
    条罗列改动，长度显著收紧（见 :data:`CLOSING_LENGTH_HINT`，阶段化长度预算的落点）。辩手在【自己的
    transcript】上收尾（全程记忆可见），故无需重述立场；举证铁律仍由系统提示常驻生效（结辩引用既有事实
    时沿用已核实 / 待核实标记，不新引未核实事实充当胜负手）。"""
    return (
        f"## 结辩环节（本场辩论已充分交锋，现在请你做【结辩陈词】）\n"
        f"{role_directive(config, side)}\n\n"
        "这是你的**最后陈词**，不是新一轮立论——请【只讲胜负手】：\n"
        "- 你这一方最强的 1–2 个论点，为何它们站得住；\n"
        "- 对方针对你最关键的那条反驳，为何【不成立 / 已被你回应】。\n"
        "【不得引入任何新论据 / 新事实 / 新案例】、不复述你之前的全文、不逐条罗列改动；"
        "结辩里引用的既有事实沿用你此前的证据状态标记（不把待核实的东西临门包装成已核实当胜负手）。"
        f"{CLOSING_LENGTH_HINT}\n\n"
        "直接输出你的结辩陈词。"
    )


def closing_context_blocks(config: DebateConfig, side: DebateSide) -> list[ContextBlock]:
    """结辩环节 continue_run 的【收到的上下文】展示投影（上下文传递可视化）——与 :func:`closing_task`
    同源孪生。结辩不再喂对手全文（辩手全程记忆已在 session 里），只给「请做结辩、只讲胜负手」这一定调，
    前端结辩修订节点的「收到的上下文」据此渲染，而非空白或沿用上一轮的逐轮任务。"""
    _ = side  # 结辩定调对各方一致（角色差异已由 role_directive 进 feedback），此处不因方而变。
    return [ContextBlock(channel="closing", heading="结辩环节", body=_CLOSING_CONTEXT_BODY)]
