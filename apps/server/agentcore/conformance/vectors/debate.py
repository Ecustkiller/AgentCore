"""Conformance vector builders — debate and roundtable scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from agentcore.runtime.events import (
    FinishReason,
    content_delta,
    debate_result,
    debate_round,
    debate_round_started,
    message_end,
    message_start,
    run_completed,
    run_output_delta,
    run_plan,
    run_started,
)

from ._common import _CONV, _COST, _USAGE

from collections.abc import Callable

def _multi_agent_debate() -> list[SSEEvent]:
    """多 Agent：辩论（debate 工具 / 主持人驱动）。两段 run_plan(plan_type="debate")——先声明
    主持人节点（CEO 不进图，主持人 ``parent_run_id`` 引用 CEO captain run、节点不在图），再声明
    本轮正反辩手（携 stance/group/round，parent=主持人）；主持人走 run_started→run_completed
    完整生命周期（团队进度因此 3/3 正确收尾，不再有永久 pending 的编排节点），收场 debate_result
    承载【决策简报 + 交锋叙事线】双产物——三端 verbatim 折入 ProjectedTurn.debate，各方发言全文
    靠 rounds[*].sides[*].run_id 关联执行图辩手节点。"""
    cap, mod = "captain1", "debate_mod1"
    pro_run, con_run = f"{mod}_r1_pro", f"{mod}_r1_con"
    mod_agents = [
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持正反辩论：是否采用方案 A",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "d_pro",
            "role": "支持方",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_con",
            "role": "反对方",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    debater_runs = [
        {
            "id": pro_run,
            "agent_id": "d_pro",
            "task": "论证支持采用方案 A",
            "depends_on": [],
            "parent_run_id": mod,
            "stance": "pro",
            "group": "debate:debate",
            "round": 1,
        },
        {
            "id": con_run,
            "agent_id": "d_con",
            "task": "论证反对采用方案 A",
            "depends_on": [],
            "parent_run_id": mod,
            "stance": "con",
            "group": "debate:debate",
            "round": 1,
        },
    ]
    debate_payload = {
        "form": "debate",
        "motion": "是否采用方案 A",
        "stop_reason": "converged",
        "narrative_first": False,
        "sides": [
            # 真·多模型辩论：各方携显式 model（pro=豆包前缀路由 / con=无前缀默认 DeepSeek），
            # 锚定「正方=豆包 vs 反方=DeepSeek」展示链的跨端对齐（model 随 sides verbatim 折入）。
            {
                "key": "pro",
                "name": "支持方",
                "stance": "支持采用方案 A",
                "is_subject": False,
                "model": "doubao/doubao-seed-2-1-turbo-260628",
            },
            {
                "key": "con",
                "name": "反对方",
                "stance": "反对采用方案 A",
                "is_subject": False,
                "model": "deepseek-v4-pro",
            },
        ],
        "rounds": [
            {
                "round_no": 1,
                "focus": "方案 A 的收益与风险敞口",
                "summary": "支持方强调收益可量化，反对方指出缺乏风险兜底，焦点收敛到风险可控性。",
                "verdict": {
                    "real_clash": True,
                    "new_arguments": False,
                    "converged": True,
                    "stop_reason": "双方核心分歧已充分暴露，无新论据。",
                    "rationale": "争点收敛到风险可控性这一关键点，继续无新增信息。",
                },
                "sides": [
                    {"key": "pro", "name": "支持方", "run_id": pro_run, "ok": True},
                    {"key": "con", "name": "反对方", "run_id": con_run, "ok": True},
                ],
                "clashes": [
                    {
                        "from_key": "con",
                        "to_key": "pro",
                        "point": "收益可量化但未对冲风险敞口，量化口径回避了尾部风险。",
                    },
                ],
            },
        ],
        "brief": {
            "crux": "方案 A 的风险是否可控",
            "strongest_points": {"pro": "收益显著且可量化", "con": "风险敞口缺乏兜底"},
            "factual_disputes": ["历史故障率的数据口径不一致"],
            "value_disputes": ["增长优先 vs 稳健优先"],
            "leaning": "倾向有条件采用",
            "confidence": "medium",
            "recommendation": "先小流量灰度验证风险，再决定是否全量。",
            "open_questions": ["灰度的回滚阈值如何设定？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我发起一场正反辩论来定夺。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="正反辩论：是否采用方案 A",
            agents=mod_agents,
            runs=mod_runs,
        ),
        run_started(mod, mod, parent_run_id=cap),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="",
            agents=debater_agents,
            runs=debater_runs,
        ),
        run_started(pro_run, "d_pro", parent_run_id=mod),
        run_output_delta(pro_run, "d_pro", "支持理由：收益可量化。"),
        run_completed(
            pro_run,
            "d_pro",
            output_summary="支持方陈述完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(con_run, "d_con", parent_run_id=mod),
        run_output_delta(con_run, "d_con", "反对理由：风险无兜底。"),
        run_completed(
            con_run,
            "d_con",
            output_summary="反对方陈述完成",
            duration_ms=850,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="方案 A 的风险是否可控",
            duration_ms=2000,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        message_end(FinishReason.END_TURN, input_tokens=3000, output_tokens=500, cost=_COST),
    ]

def _multi_agent_roundtable_rounds() -> list[SSEEvent]:
    """多 Agent：圆桌（roundtable）逐轮增量 + 中途取消。主持人逐轮 emit ``debate_round_started``
    （发言【前】给焦点）/ ``debate_round``（裁判 + 小结【后】给整轮）——三端折叠成 ProjectedTurn.
    debateRounds：第 1 轮完整（focus/summary/verdict/各方→辩手 run_id），第 2 轮仅开场
    （focus，verdict=None=进行中）后被取消。后续轮辩手是首轮的续写 revision（``revision=2`` +
    ``parent_run_id``，三端从 run_started 合成修订节点 + 继承原 agent 身份）。无 ``debate_result``
    （中途停）→ debate 恒 None，叙事线只在 debateRounds（这正是进行中实时叠加的覆盖点）。
    圆桌辩手节点携 ``group=debate:roundtable`` + ``round`` 但【无 stance】（多方非二元正反）。"""
    cap, mod = "captain1", "rt_mod1"
    r1a, r1b, r1c = f"{mod}_r1_a", f"{mod}_r1_b", f"{mod}_r1_c"
    r2a, r2b = f"{mod}_r2_a", f"{mod}_r2_b"
    mod_agents = [
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持多方圆桌：AI 该如何治理",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "rt_a",
            "role": "技术视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_b",
            "role": "监管视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_c",
            "role": "产业视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    debater_runs = [
        {
            "id": r1a,
            "agent_id": "rt_a",
            "task": "从技术视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": r1b,
            "agent_id": "rt_b",
            "task": "从监管视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": r1c,
            "agent_id": "rt_c",
            "task": "从产业视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
    ]
    round1_payload = {
        "round_no": 1,
        "focus": "AI 治理的第一性问题：风险从何而来",
        "summary": "技术方归因能力外溢，监管方强调问责缺位，产业方提醒落地成本，焦点铺成三条光谱。",
        "verdict": {
            "real_clash": True,
            "new_arguments": True,
            "converged": False,
            "stop_reason": "",
            "rationale": "三方视角已铺开但尚未交锋收敛，值得再探一轮。",
        },
        "sides": [
            {"key": "a", "name": "技术视角", "run_id": r1a, "ok": True},
            {"key": "b", "name": "监管视角", "run_id": r1b, "ok": True},
            {"key": "c", "name": "产业视角", "run_id": r1c, "ok": True},
        ],
        "clashes": [
            {
                "from_key": "b",
                "to_key": "a",
                "point": "能力外溢说回避了问责主体，技术归因不能替代责任分配。",
            },
            {
                "from_key": "c",
                "to_key": "b",
                "point": "强问责会抬高合规成本，产业落地承受不起一刀切立法。",
            },
        ],
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来组织一场多方圆桌。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="多方圆桌：AI 该如何治理",
            agents=mod_agents,
            runs=mod_runs,
        ),
        run_started(mod, mod, parent_run_id=cap),
        # 第 1 轮：开场先报焦点（发言【前】），再声明本轮辩手 + 各方发言，收尾报整轮裁判 + 小结。
        debate_round_started(
            execution_id="exec1", moderator_run_id=mod, round_no=1, focus=round1_payload["focus"]
        ),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="",
            agents=debater_agents,
            runs=debater_runs,
        ),
        run_started(r1a, "rt_a", parent_run_id=mod),
        run_output_delta(r1a, "rt_a", "技术视角：能力外溢是根因。"),
        run_completed(
            r1a,
            "rt_a",
            output_summary="技术视角发言完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(r1b, "rt_b", parent_run_id=mod),
        run_output_delta(r1b, "rt_b", "监管视角：问责缺位才是关键。"),
        run_completed(
            r1b,
            "rt_b",
            output_summary="监管视角发言完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(r1c, "rt_c", parent_run_id=mod),
        run_output_delta(r1c, "rt_c", "产业视角：别忽视落地成本。"),
        run_completed(
            r1c,
            "rt_c",
            output_summary="产业视角发言完成",
            duration_ms=810,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_round(execution_id="exec1", moderator_run_id=mod, payload=round1_payload),
        # 第 2 轮：开场报焦点（verdict 仍 None=进行中），辩手续写（revision=2）发言中被取消。
        debate_round_started(
            execution_id="exec1",
            moderator_run_id=mod,
            round_no=2,
            focus="第二轮：三方就『问责机制』正面交锋",
        ),
        run_started(r2a, "rt_a2", parent_run_id=r1a, revision=2),
        run_output_delta(r2a, "rt_a2", "技术视角续：问责需可观测性支撑。"),
        run_started(r2b, "rt_b2", parent_run_id=r1b, revision=2),
        run_output_delta(r2b, "rt_b2", "监管视角续：可观测性应立法强制。"),
        message_end(FinishReason.CANCELLED, input_tokens=4000, output_tokens=700, cost=_COST),
    ]

def _multi_agent_red_team() -> list[SSEEvent]:
    """多 Agent：红队审查【收场】(red_team settled)。被审【方案方】(is_subject=true) 承受红队的
    单向攻击并回应修补，主持人逐轮挖风险、判是否挖尽，收场 debate_result(form="red_team") 承载
    【风险看板 + 交锋叙事线】双产物：红队成员的 strongest_points = 最尖锐风险、方案方的 = 其抗辩，
    recommendation = 加固建议。三名红队成员（安全 / 合规 / 运维）携 brief.risk_severities
    = high/medium/low，验【风险看板】按严重度分级 + 总览计数（高危 1 · 中危 1 · 低危 1）+ 由危到轻
    排序；其余红队简报骨架（加固建议 / 方案方回应 / 还需厘清）与正反辩论同一套主次（结论先行 +
    价值之争提为「需你拍板」+ 事实分歧/待解降级），逐轮走风险看板研判。"""
    cap, mod = "captain1", "redteam_mod1"
    subj_run = f"{mod}_r1_subject"
    red1_run = f"{mod}_r1_red1"
    red2_run = f"{mod}_r1_red2"
    red3_run = f"{mod}_r1_red3"
    mod_agents = [
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持红队审查：压测「自建鉴权服务」方案",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "d_subject",
            "role": "方案方",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red1",
            "role": "安全红队",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red2",
            "role": "合规红队",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "d_red3",
            "role": "运维红队",
            "model_preference": "fast",
            "thinking": False,
            "reasoning_effort": "low",
        },
    ]
    debater_runs = [
        {
            "id": subj_run,
            "agent_id": "d_subject",
            "task": "为「自建鉴权服务」方案抗辩并修补",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": red1_run,
            "agent_id": "d_red1",
            "task": "挖「自建鉴权服务」方案的安全风险",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": red2_run,
            "agent_id": "d_red2",
            "task": "审「自建鉴权服务」方案的合规缺口",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
        {
            "id": red3_run,
            "agent_id": "d_red3",
            "task": "查「自建鉴权服务」方案的运维隐患",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:red_team",
            "round": 1,
        },
    ]
    debate_payload = {
        "form": "red_team",
        "motion": "压测「自建鉴权服务」方案的稳健性",
        "stop_reason": "red_team_exhausted",
        "narrative_first": False,
        # 红队=被审方案方(is_subject) + ≥1 红队；语义名对称同风格（方案方 / 安全红队），不混入模型名。
        "sides": [
            {
                "key": "subject",
                "name": "方案方",
                "stance": "自建鉴权可控且省授权成本",
                "is_subject": True,
                "model": "",
            },
            {
                "key": "red1",
                "name": "安全红队",
                "stance": "自建鉴权的攻击面与凭证安全",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "red2",
                "name": "合规红队",
                "stance": "自建鉴权的合规与审计缺口",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "red3",
                "name": "运维红队",
                "stance": "自建鉴权的长期运维负担",
                "is_subject": False,
                "model": "",
            },
        ],
        "rounds": [
            {
                "round_no": 1,
                "focus": "凭证存储与会话固定的攻击面",
                "summary": "红队指出自建鉴权易踩 token 泄漏与会话固定，方案方承认需补固化与轮换。",
                "verdict": {
                    "real_clash": True,
                    "new_arguments": True,
                    "converged": False,
                    "stop_reason": "",
                    "rationale": "红队挖出有效风险，方案方部分采纳，仍有未覆盖项。",
                },
                "sides": [
                    {"key": "subject", "name": "方案方", "run_id": subj_run, "ok": True},
                    {"key": "red1", "name": "安全红队", "run_id": red1_run, "ok": True},
                    {"key": "red2", "name": "合规红队", "run_id": red2_run, "ok": True},
                    {"key": "red3", "name": "运维红队", "run_id": red3_run, "ok": True},
                ],
                "clashes": [
                    {
                        "from_key": "red1",
                        "to_key": "subject",
                        "point": "未做 token 轮换与设备绑定，刷新令牌一旦泄漏即长期可用。",
                    },
                    {
                        "from_key": "red2",
                        "to_key": "subject",
                        "point": "缺审计日志留存与访问追溯，过不了等保与合规审查。",
                    },
                ],
            },
        ],
        "brief": {
            "crux": "自建鉴权的攻击面是否可控、加固成本是否低于外采",
            "strongest_points": {
                "red1": "刷新令牌缺轮换与设备绑定，泄漏即长期可用，是最尖锐风险。",
                "red2": "无审计日志留存与访问追溯，过不了等保三级与合规审查。",
                "red3": "密钥轮换 / 应急吊销全靠人肉，长期运维负担与误操作风险偏高。",
                "subject": "可引入短时访问令牌 + 轮换刷新令牌，把风险降到与外采相当。",
            },
            # 红队风险严重度（驱动前端风险看板分级 + 总览计数）：安全=高危、合规=中危、运维=低危；
            # 被审方案方(subject)不评级。
            "risk_severities": {
                "red1": "high",
                "red2": "medium",
                "red3": "low",
            },
            "factual_disputes": ["自建 vs 外采的真实合规改造工作量缺乏一致口径"],
            "value_disputes": ["把鉴权握在自己手里的掌控感 vs 外采省心"],
            "leaning": "有条件通过：先补 3 项加固再上线",
            "confidence": "medium",
            "recommendation": "上线前必须：① 刷新令牌轮换 + 设备绑定 ② 登录限速与异常告警 ③ 第三方渗透测试。",
            "open_questions": ["密钥轮换的运维归属谁？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我发起一场红队审查来压测这个方案。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="红队审查：压测「自建鉴权服务」方案",
            agents=mod_agents,
            runs=mod_runs,
        ),
        run_started(mod, mod, parent_run_id=cap),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="",
            agents=debater_agents,
            runs=debater_runs,
        ),
        run_started(subj_run, "d_subject", parent_run_id=mod),
        run_output_delta(subj_run, "d_subject", "方案方：自建鉴权可控、省授权成本。"),
        run_completed(
            subj_run,
            "d_subject",
            output_summary="方案方抗辩完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(red1_run, "d_red1", parent_run_id=mod),
        run_output_delta(red1_run, "d_red1", "安全红队：刷新令牌缺轮换，泄漏即长期可用。"),
        run_completed(
            red1_run,
            "d_red1",
            output_summary="安全红队挖掘完成",
            duration_ms=860,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(red2_run, "d_red2", parent_run_id=mod),
        run_output_delta(red2_run, "d_red2", "合规红队：缺审计日志留存，过不了等保合规。"),
        run_completed(
            red2_run,
            "d_red2",
            output_summary="合规红队挖掘完成",
            duration_ms=780,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(red3_run, "d_red3", parent_run_id=mod),
        run_output_delta(red3_run, "d_red3", "运维红队：密钥轮换全靠人肉，长期负担偏高。"),
        run_completed(
            red3_run,
            "d_red3",
            output_summary="运维红队挖掘完成",
            duration_ms=540,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="自建鉴权的攻击面是否可控",
            duration_ms=2100,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        message_end(FinishReason.END_TURN, input_tokens=3200, output_tokens=560, cost=_COST),
    ]

def _multi_agent_roundtable_settled() -> list[SSEEvent]:
    """多 Agent：圆桌探讨【收场】(roundtable settled)。3 视角多边碰撞后主持人收场，debate_result
    (form="roundtable") 承载【观点光谱 + 交锋叙事线】双产物：strongest_points 按 side.key 给各视角
    核心主张（光谱），leaning=综合观察、recommendation=建议。探讨无单一裁决/赢家。验「观点光谱」英雄
    区（置顶 glanceable）+ 叙事后简报小结（共同焦点一行 / 需你拍板 / 还需厘清），与正反/红队同一套
    次级信息主次（去掉旧版等权 DisputeSection，三形态一致）。圆桌辩手无 stance（多方非二元正反）。"""
    cap, mod = "captain1", "rts_mod1"
    ra, rb, rc = f"{mod}_r1_a", f"{mod}_r1_b", f"{mod}_r1_c"
    mod_agents = [
        {
            "id": mod,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    mod_runs = [
        {
            "id": mod,
            "agent_id": mod,
            "task": "主持多方圆桌：AI 该如何治理",
            "depends_on": [],
            "parent_run_id": cap,
        },
    ]
    debater_agents = [
        {
            "id": "rt_a",
            "role": "技术视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_b",
            "role": "监管视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
        {
            "id": "rt_c",
            "role": "产业视角",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        },
    ]
    debater_runs = [
        {
            "id": ra,
            "agent_id": "rt_a",
            "task": "从技术视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": rb,
            "agent_id": "rt_b",
            "task": "从监管视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
        {
            "id": rc,
            "agent_id": "rt_c",
            "task": "从产业视角谈 AI 治理",
            "depends_on": [],
            "parent_run_id": mod,
            "group": "debate:roundtable",
            "round": 1,
        },
    ]
    debate_payload = {
        "form": "roundtable",
        "motion": "AI 该如何治理",
        "stop_reason": "converged",
        "narrative_first": False,
        # 圆桌≥3 视角，语义名对称同风格（技术 / 监管 / 产业视角）；无 is_subject、无 stance。
        "sides": [
            {
                "key": "a",
                "name": "技术视角",
                "stance": "风险源于能力外溢，治理应内建可观测与熔断",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "b",
                "name": "监管视角",
                "stance": "缺的是问责主体，须以立法明确责任归属",
                "is_subject": False,
                "model": "",
            },
            {
                "key": "c",
                "name": "产业视角",
                "stance": "一刀切立法抬高合规成本，应分级分场景落地",
                "is_subject": False,
                "model": "",
            },
        ],
        "rounds": [
            {
                "round_no": 1,
                "focus": "AI 治理的主轴：先管能力还是先管问责",
                "summary": "技术方归因能力外溢，监管方强调问责缺位，产业方提醒落地成本，三方收敛到分级治理。",
                "verdict": {
                    "real_clash": True,
                    "new_arguments": False,
                    "converged": True,
                    "stop_reason": "三方视角已充分铺开并就分级治理形成交集。",
                    "rationale": "光谱铺满且出现交集，继续无新增视角。",
                },
                "sides": [
                    {"key": "a", "name": "技术视角", "run_id": ra, "ok": True},
                    {"key": "b", "name": "监管视角", "run_id": rb, "ok": True},
                    {"key": "c", "name": "产业视角", "run_id": rc, "ok": True},
                ],
                "clashes": [
                    {
                        "from_key": "b",
                        "to_key": "a",
                        "point": "能力外溢说回避了问责主体，技术归因不能替代责任分配。",
                    },
                    {
                        "from_key": "c",
                        "to_key": "b",
                        "point": "强问责会抬高合规成本，产业落地承受不起一刀切立法。",
                    },
                ],
            },
        ],
        "brief": {
            "crux": "AI 治理的主轴：先管能力还是先管问责",
            "strongest_points": {
                "a": "风险源于能力外溢，治理应内建可观测与熔断。",
                "b": "缺的是问责主体，须以立法明确责任归属。",
                "c": "一刀切立法抬高合规成本，应分级分场景落地。",
            },
            "factual_disputes": ["现有事故里『能力外溢』与『问责缺位』各占多少缺一致数据"],
            "value_disputes": ["创新速度优先 vs 风险兜底优先"],
            "leaning": "三方共识：分级治理 + 可观测先行，问责随之立法",
            "confidence": "medium",
            "recommendation": "按能力分级，先强制高风险场景的可观测与熔断，再补问责立法。",
            "open_questions": ["谁来认定与维护『高风险场景』清单？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我来组织一场多方圆桌并收场。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="多方圆桌：AI 该如何治理",
            agents=mod_agents,
            runs=mod_runs,
        ),
        run_started(mod, mod, parent_run_id=cap),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="",
            agents=debater_agents,
            runs=debater_runs,
        ),
        run_started(ra, "rt_a", parent_run_id=mod),
        run_output_delta(ra, "rt_a", "技术视角：能力外溢是根因，需可观测与熔断。"),
        run_completed(
            ra,
            "rt_a",
            output_summary="技术视角发言完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(rb, "rt_b", parent_run_id=mod),
        run_output_delta(rb, "rt_b", "监管视角：问责缺位才是关键，须立法明确。"),
        run_completed(
            rb,
            "rt_b",
            output_summary="监管视角发言完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(rc, "rt_c", parent_run_id=mod),
        run_output_delta(rc, "rt_c", "产业视角：别忽视落地成本，应分级分场景。"),
        run_completed(
            rc,
            "rt_c",
            output_summary="产业视角发言完成",
            duration_ms=810,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="AI 治理的主轴：先管能力还是先管问责",
            duration_ms=2200,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        message_end(FinishReason.END_TURN, input_tokens=3400, output_tokens=600, cost=_COST),
    ]


VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "multi_agent_debate": ("多 Agent：辩论（debate 工具）主持人→辩手 + 决策简报/叙事线双产物", _multi_agent_debate),
    "multi_agent_roundtable_rounds": ("多 Agent：圆桌逐轮增量（debate_round_started/debate_round）+ 续写 revision + 中途取消", _multi_agent_roundtable_rounds),
    "multi_agent_red_team": ("多 Agent：红队审查收场（form=red_team）风险看板 + 加固建议 + 方案方回应双产物", _multi_agent_red_team),
    "multi_agent_roundtable_settled": ("多 Agent：圆桌探讨收场（form=roundtable）观点光谱英雄区 + 叙事后简报小结双产物", _multi_agent_roundtable_settled),
}
