"""Legal vertical (法律垂直) domain Skills — v0「答辩状作战室」.

This is the first DOMAIN capability pack, separate from the platform-mechanism
system skills in :mod:`agentcore.runtime.skills` (different reason-to-change: legal
domain content evolves on its own axis). It registers into the SAME
:class:`~agentcore.runtime.skills.SkillRegistry` as the system skills — surfaced in
the CEO's 能力目录 and pulled via ``consult_skill`` — but ONLY when the legal vertical
is enabled (``settings.legal_vertical_enabled``), so generic deployments never see
legal content in the catalog.

Design (见 docs/07-规划/法律垂直场景设计.md §六): v0 builds NO new infra. The
「对方律师作战室」hero rides existing primitives — ``delegate`` (起草 / 核验 / 格式 worker)
+ ``debate(form=red_team, is_subject=...)`` (原告红队单向攻、我方回应修补) +
``checkpoint_after`` / ``ask_user`` (人审闸门) + web 检索 (法条接地). This Skill is the
only NEW thing: the domain HOW-guidance the CEO consults to orchestrate that team and
the anti-hallucination constraints it must enforce. Stopgap home is the system-skill
registry; it graduates to a per-agent market Skill once that infra lands.
"""

from __future__ import annotations

from agentcore.runtime.skills import SystemSkill

_LEGAL_ANSWER_BRIEF = """\
<legal_answer_brief>
写 / 打磨民事【答辩状】时，别让单个写手闷头出稿——按「对方律师作战室」组队：你方起草 →【原告红队\
先把你打一遍】→ 逐条核验法条 → 格式查缺 → 人审收口。红队预演对方如何反击，是单写手给不了的核心价值。

【一、先解析对方起诉状（答辩的地基）】
从用户提供的起诉状 + 我方事实里抽清：① 诉讼请求（逐项）；② 事实与理由；③ 证据清单；④ 所依法条；\
⑤ 管辖与主体。答辩必须【逐项对应】原告诉请，不可泛泛而谈。

【二、答辩状的要素结构（交给起草 worker 的需求，不是替它写骨架）】
- 程序性抗辩：管辖异议 / 主体不适格 / 诉讼时效已过 / 重复起诉 / 必要共同诉讼人缺漏 / 不属于民事受案范围等——【先于实体】审查，有则先打。
- 实体性抗辩：逐条反驳原告的事实主张与法律适用；主张抗辩事由（已履行 / 已抵销 / 免责约定 / 不可抗力 / 对方违约在先 / 权利已消灭等）。
- 证据质证：对原告每份证据质疑真实性 / 合法性 / 关联性，并列我方反证。
- 法律依据：每个抗辩点对应的法条 / 司法解释（【必须经核验】，见末「反幻觉硬约束」）。
- 答辩意见（诉求）：请求【驳回 / 部分驳回】原告诉请。

【三、作战室编排（用现有工具，别造新流程）】
1. 起草：`delegate` 一个「答辩状起草」worker 出初稿（把上面要素结构作为需求交给它，结构与论证脉络留给它设计）。\
【缺我方事实时】答辩的地基是我方事实——若用户只给了对方起诉状、未给我方事实（货物 / 质量 / 付款 / 催告 /\
证据等），优先用 `ask_user` 把关键事实要齐再起草；若用户要直接开工，则以起诉状可推定的标准抗辩（管辖 /\
时效 / 违约金过高 / 质量异议）起草，并把缺失的我方事实【显式标为假设】交红队压测——两种都【绝不编造】我方事实。
2. 【原告红队（hero 核心）】：拿到初稿后用 `debate` 工具、`form="red_team"`，把【我方答辩】标 `is_subject=true`\
（承受单向攻击并回应修补），另设【原告红队】方站对方代理人立场逐条挑漏洞。典型 sides：
   - `{key:"defense", name:"我方答辩", stance:"为我方答辩状辩护，回应原告攻击并就站不住的点修补", is_subject:true}`
   - `{key:"plaintiff", name:"原告红队", stance:"站原告/对方代理人立场，逐条攻击我方每个抗辩：程序抗辩能否成立、事实主张有无证据、法条引用是否准确/被修订、抗辩事由是否适用、有无遗漏对原告有利的事实"}`
   - motion 写成「压力测试我方答辩状：原告会如何反击、有哪些漏洞、哪些抗辩站不住」。轮数交主持人自调，你不设。
3. 核验：`delegate` 一个「法条核验」worker，对答辩里【实际引用】的每一条法条 / 司法解释做检索接地\
核对——条号、现行有效性（是否被修订 / 废止）、内容是否吻合、时效起算。【检索有界，勿死磕】逐条核验、\
每条至多 1～2 次检索：命中权威摘要即停、拿不到即标『[待核验]』转人审，【不要】为凑全 / 求精反复换词重搜\
或扩大检索面（核验贵在准，不在多）。【检索现实】优先 `web_search` 拿权威摘要 / 条文；`flk.npc.gov.cn` 等\
政务站常 SSL / 超时，`read_url` 打不开就退 `web_search` 摘要或换权威源（全国人大网 / 最高法），勿对同一\
站点反复重试；拿不到权威全文就按「反幻觉硬约束」标『[待核验]』交人审，绝不凭记忆写定。
4. 格式查缺：`delegate` 一个「格式完备」worker 对照民事答辩状规范查缺（首部当事人信息、案由、落款日期、证据目录等）。
5. 收口：若有活跃用户，终稿前用 `checkpoint_after`（多步流水线里）或 `ask_user` 设【人审闸门】，把红队\
攻防结论 + 核验结果摊给用户/律师拍板；再汇总为可复核终稿。多步可在【同一次 delegate】用 `depends_on` 串：起草 → 核验/格式（并行）→ 收口。

【四、原告红队对抗剧本（喂给红队方 stance 的攻击清单）】
逐条质问：这条程序抗辩法院会不会驳？这个事实主张我方有证据吗、举证责任在谁？引的法条是否准确、是否已被\
修订或不适用本案？抗辩事由构成要件齐不齐？是否漏了对原告有利、我方未回应的关键事实？时效抗辩起算点站得住吗？

【五、反幻觉硬约束（真交付律师档位的底线，不可省）】
- 未经检索核验，【不得】写出任何具体法条 / 司法解释条号与内容——宁可标「[待核验：拟引《X 法》第 Y 条]」交核验 worker，也不可凭记忆直接写定。
- 每条法律引用须标注出处与法域（默认【中国大陆法】）；引用现行有效版本。
- 终稿附免责声明：「本文为 AI 辅助起草，须执业律师复核后使用，不构成法律意见。」
- 涉及具体诉请、关键抗辩或不可逆提交前，必过【人审闸门】（见编排第 5 步）。
</legal_answer_brief>"""


# The legal vertical's v0 skill set. Registered into the shared SkillRegistry only
# when ``settings.legal_vertical_enabled`` (see runtime/skills.build_system_skill_registry).
LEGAL_SKILLS: tuple[SystemSkill, ...] = (
    SystemSkill(
        name="legal_answer_brief",
        summary=(
            "写 / 打磨民事答辩状时用「对方律师作战室」：delegate 起草 → debate(red_team) 原告红队"
            "单向攻防 → 法条接地核验 → 人审收口（含反幻觉硬约束）"
        ),
        body=_LEGAL_ANSWER_BRIEF,
        # 起草/核验/格式靠 delegate；原告红队靠 debate。两者在 CEO 路径恒被装配——
        # gating 仍正确声明依赖，红队是 hero 核心故 debate 必备。
        requires_tools=("delegate", "debate"),
    ),
)
