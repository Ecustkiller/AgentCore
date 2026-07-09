"""Conformance vector builders — debate and roundtable scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import (
    FinishReason,
    SSEEvent,
    content_delta,
    debate_result,
    debate_round,
    debate_round_started,
    message_end,
    message_start,
    run_completed,
    run_context,
    run_output_delta,
    run_plan,
    run_started,
)

from ._common import _CONV, _COST, _USAGE, _ctx_block


def _multi_agent_debate() -> list[SSEEvent]:
    """多 Agent：辩论（debate 工具 / 主持人驱动）。两段 run_plan(plan_type="debate")——先声明
    主持人节点（CEO 不进图，主持人 ``parent_run_id`` 引用 CEO captain run、节点不在图），再声明
    本轮正反辩手（携 stance/group/round，parent=主持人）；主持人走 run_started→run_completed
    完整生命周期（团队进度因此 3/3 正确收尾，不再有永久 pending 的编排节点），收场 debate_result
    承载【决策简报 + 交锋叙事线】双产物——三端 verbatim 折入 ProjectedTurn.debate，各方发言全文
    靠 rounds[*].sides[*].run_id 关联执行图辩手节点。

    亦承载【质询回合 P1 + 记分裁判 P2】端到端契约：本轮 ``cross_exam`` = 主持人代表交锋向各方发的
    定向必答质询（问题 verbatim 进载荷、作答全文随 ``answer_run_id`` 的 continue_run 事件走，故各方
    多出一个 ``_r1_cx_{key}`` 质询作答 run——faithful：作答是 continue_run，run_started 携 revision=2 +
    原辩手 stance/group/round）；``scores`` = 裁判本轮给各方的三维记分 + 罚分 + 净分；``brief.decisive``
    = 据逐轮记分推导的胜负手。三者均为附加字段（settledModel 据 answer_run_id 取回作答、据 scores/
    decisive 渲染比分与胜负手），载荷恒带空集合/空对象。

    亦承载【结辩收束 P4】端到端契约：收场 ``closings`` = 辩已辩尽后各方的结辩陈词（身份 verbatim 进载荷、
    陈词全文随 ``run_id`` 的 continue_run 事件走，故各方在质询后再多一个 ``_closing_{key}`` 结辩 run——
    faithful：结辩是 continue_run，run_started 携 revision=3 + 原辩手 stance/group/round）；settledModel 据
    ``closings[*].run_id`` 取回陈词全文渲染「结辩陈词」区。载荷恒带空集合/空对象。"""
    cap, mod = "captain1", "debate_mod1"
    pro_run, con_run = f"{mod}_r1_pro", f"{mod}_r1_con"
    pro_cx, con_cx = f"{mod}_r1_cx_pro", f"{mod}_r1_cx_con"
    pro_closing, con_closing = f"{mod}_closing_pro", f"{mod}_closing_con"
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
        # 主持人开场白（可选、渐进式契约）：证明「会说话的主持人」开场白经 fold verbatim 折入
        # ProjectedTurn.debate.opening 的端到端链路；其余向量省略此字段验证缺省回落（前端拼模板）。
        "opening": "这场要定的是该不该上方案 A，先从最要害的成本与收益切入。",
        "narrative_first": False,
        "sides": [
            {
                "key": "pro",
                "name": "支持方",
                "stance": "支持采用方案 A",
                "is_subject": False,
            },
            {
                "key": "con",
                "name": "反对方",
                "stance": "反对采用方案 A",
                "is_subject": False,
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
                # 质询回合（P1）：主持人定向必答质询各方，作答全文随 answer_run_id 的 run 走（不塞载荷）。
                "cross_exam": [
                    {
                        "target": "pro",
                        "questioner": "",
                        "exchanges": [
                            {
                                "question": "收益量化口径是否计入了尾部风险？请是/否直接回答。",
                                "answer": "量化口径未含尾部风险【待核实·推断】",
                                "ok": True,
                            },
                            {
                                "question": "若熔断触发、灰度止损，已投入成本由谁承担？",
                                "answer": "成本由灰度预算池兜底、触发熔断即回滚【已核实·灰度预案v2】",
                                "ok": True,
                            },
                        ],
                        "answer_run_id": pro_cx,
                    },
                    {
                        "target": "con",
                        "questioner": "",
                        "exchanges": [
                            {
                                "question": "你主张的风险敞口，有无可量化的历史故障率支撑？没有就直说。",
                                "answer": "暂无统一口径的历史故障率【待核实·推断】；但同类系统的尾部事件可作参照【已核实·SRE年报】",
                                "ok": True,
                            },
                        ],
                        "answer_run_id": con_cx,
                    },
                ],
                # 记分裁判（P2）：本轮各方三维记分 + 罚分（每条 -1）+ 净分 total（后端算好、前端直用）。
                "scores": {
                    "pro": {
                        "argument": 4,
                        "engagement": 3,
                        "evidence": 3,
                        "penalties": [],
                        "note": "收益量化扎实，质询下承认口径未含尾部但给出熔断兜底。",
                        "total": 10,
                    },
                    "con": {
                        "argument": 3,
                        "engagement": 4,
                        "evidence": 2,
                        "penalties": ["以未证实的尾部风险当既定事实"],
                        "note": "紧咬风险敞口命门、回应完整，但缺量化证据且有一处未支撑主张。",
                        "total": 8,
                    },
                },
            },
        ],
        # 结辩收束（P4）：辩已辩尽后各方的结辩陈词（身份 verbatim 进载荷、陈词全文随 run_id 的 run 走），
        # settledModel 据 closings[*].run_id 取回渲染「结辩陈词」区。仅认真辩透 + 对抗形态开启。
        "closings": [
            {"key": "pro", "name": "支持方", "run_id": pro_closing, "ok": True},
            {"key": "con", "name": "反对方", "run_id": con_closing, "ok": True},
        ],
        "brief": {
            "crux": "方案 A 的风险是否可控",
            "strongest_points": {"pro": "收益显著且可量化", "con": "风险敞口缺乏兜底"},
            "factual_disputes": ["历史故障率的数据口径不一致"],
            "value_disputes": ["增长优先 vs 稳健优先"],
            # 胜负手（P2）：据逐轮记分推导——点名谁的哪点被扣分 / 更站得住，让 leaning 可追溯。
            "decisive": "反对方紧咬「风险敞口未对冲」命门，却把未证实的尾部风险当既定事实（记分 -1）；支持方收益量化更扎实、质询下给出熔断兜底，综合净分小幅领先（10 : 8）。",
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
        run_output_delta(
            pro_run,
            "d_pro",
            "支持理由：收益可量化——首年可降本【已核实·2024成本审计】约 18%，"
            "同类系统迁移回收周期约两个季度【待核实·推断】。",
        ),
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
        run_output_delta(
            con_run,
            "d_con",
            "反对理由：风险缺兜底——迁移期存在双写不一致窗口【已核实·内部SRE复盘】，"
            "尾部故障率恐被低估【待核实·推断】。",
        ),
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
        # 质询回合（P1）：陈述后、裁判前，各方对主持人质询 continue_run 作答（faithful：作答是续写，
        # run_started 携 revision=2 + 原辩手 stance/group/round；run_context 展示被问了什么；作答全文
        # 随本 run 走，settledModel 据 cross_exam[*].answer_run_id=`_r1_cx_{key}` 取回渲染质询问答对）。
        run_started(
            pro_cx, pro_cx, parent_run_id=pro_run, revision=2,
            stance="pro", group="debate:debate", round_no=1,
        ),
        run_context(
            pro_cx,
            pro_cx,
            [
                _ctx_block(
                    "cross_exam",
                    "第 1 轮 · 质询（必须正面回答）",
                    "- 收益量化口径是否计入了尾部风险？请是/否直接回答。\n"
                    "- 若熔断触发、灰度止损，已投入成本由谁承担？",
                ),
            ],
        ),
        run_output_delta(
            pro_cx,
            pro_cx,
            "作答：量化口径未含尾部风险【待核实·推断】；成本由灰度预算池兜底、"
            "触发熔断即回滚【已核实·灰度预案v2】。",
        ),
        run_completed(
            pro_cx,
            pro_cx,
            output_summary="支持方质询作答完成",
            duration_ms=640,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(
            con_cx, con_cx, parent_run_id=con_run, revision=2,
            stance="con", group="debate:debate", round_no=1,
        ),
        run_context(
            con_cx,
            con_cx,
            [
                _ctx_block(
                    "cross_exam",
                    "第 1 轮 · 质询（必须正面回答）",
                    "- 你主张的风险敞口，有无可量化的历史故障率支撑？没有就直说。",
                ),
            ],
        ),
        run_output_delta(
            con_cx,
            con_cx,
            "作答：暂无统一口径的历史故障率【待核实·推断】；但同类系统的尾部事件可作参照"
            "【已核实·SRE年报】。",
        ),
        run_completed(
            con_cx,
            con_cx,
            output_summary="反对方质询作答完成",
            duration_ms=620,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        # 结辩收束（P4）：质询后、主持人终审前，各方 continue_run 做结辩陈词（faithful：结辩是续写，
        # run_started 携 revision=3 + 原辩手 stance/group/round；run_context 展示结辩定调；陈词全文随本
        # run 走，settledModel 据 closings[*].run_id=`_closing_{key}` 取回渲染「结辩陈词」区）。
        run_started(
            pro_closing, pro_closing, parent_run_id=pro_run, revision=3,
            stance="pro", group="debate:debate", round_no=1,
        ),
        run_context(
            pro_closing,
            pro_closing,
            [_ctx_block("closing", "结辩环节", "辩论已充分交锋，请做结辩陈词（只讲胜负手、不引入新论据）。")],
        ),
        run_output_delta(
            pro_closing,
            pro_closing,
            "结辩：方案 A 首年降本可核实【已核实·2024成本审计】，尾部风险有熔断兜底、"
            "触发即回滚可控——收益确定、风险有解，应有条件采用。",
        ),
        run_completed(
            pro_closing,
            pro_closing,
            output_summary="支持方结辩完成",
            duration_ms=520,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(
            con_closing, con_closing, parent_run_id=con_run, revision=3,
            stance="con", group="debate:debate", round_no=1,
        ),
        run_context(
            con_closing,
            con_closing,
            [_ctx_block("closing", "结辩环节", "辩论已充分交锋，请做结辩陈词（只讲胜负手、不引入新论据）。")],
        ),
        run_output_delta(
            con_closing,
            con_closing,
            "结辩：对方的收益量化口径始终未含尾部风险【待核实·推断】，双写不一致窗口"
            "【已核实·内部SRE复盘】未有硬兜底——风险未对冲前不宜全量。",
        ),
        run_completed(
            con_closing,
            con_closing,
            output_summary="反对方结辩完成",
            duration_ms=540,
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

def _multi_agent_debate_followup() -> list[SSEEvent]:
    """多 Agent：正反辩论【收场】带【用户追问】+【3 轮版本链】（交互式逐轮 / 追问，Phase 2）。
    第 1 轮后用户向支持方【追问】「灰度期数据口径不一致谁来兜底」并选续辩，第 2、3 轮辩手
    （continue revision）逐轮续写 → 收场 ``debate_result`` 的 ``rounds[1]`` 携 verbatim
    ``user_interjections``=``[{ask, target_key:"pro", answered:true}]``——这是【唯一耐久】的
    用户追问痕迹（决策事件 transport-only 不入 journal），三端 verbatim 折入
    ``ProjectedTurn.debate``，重载复盘可见。

    亦是【乙 wire 携 round/stance · 单一轮次投影】的 3 轮回归床（用户报的「5 轮只剩 2 版本」
    根因）：每个后续轮辩手的 ``run_started`` 携 ``stance``/``group``/``round``（r2→round 2、
    r3→round 3），三端 fold 把这三个字段投到修订节点上——故 golden 的 ``runs`` 里 pro/con 各有
    原始 + v2 + v3 三个版本、且各携真实 round，图元逐轮成链不再叠成 2 个，辩论室 2 方逐轮
    ≥2 轮发言不再丢。验「追问随轮留痕」+「修订携轮次/立场」契约全链路（types → events.ts →
    三端 verbatim fold）。"""
    cap, mod = "captain1", "debate_fu_mod1"
    pro_r1, con_r1 = f"{mod}_r1_pro", f"{mod}_r1_con"
    pro_r2, con_r2 = f"{mod}_r2_pro", f"{mod}_r2_con"
    pro_r3, con_r3 = f"{mod}_r3_pro", f"{mod}_r3_con"
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
            "task": "主持正反辩论（可追问）：是否采用方案 A",
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
            "id": pro_r1,
            "agent_id": "d_pro",
            "task": "论证支持采用方案 A",
            "depends_on": [],
            "parent_run_id": mod,
            "stance": "pro",
            "group": "debate:debate",
            "round": 1,
        },
        {
            "id": con_r1,
            "agent_id": "d_con",
            "task": "论证反对采用方案 A",
            "depends_on": [],
            "parent_run_id": mod,
            "stance": "con",
            "group": "debate:debate",
            "round": 1,
        },
    ]
    round1_payload = {
        "round_no": 1,
        "focus": "方案 A 的收益与风险敞口",
        "summary": "支持方强调收益可量化，反对方指出缺乏风险兜底，焦点收敛到风险可控性。",
        "verdict": {
            "real_clash": True,
            "new_arguments": True,
            "converged": False,
            "stop_reason": "",
            "rationale": "核心交锋已起，但风险兜底尚未谈透，值得再探一轮。",
        },
        "sides": [
            {"key": "pro", "name": "支持方", "run_id": pro_r1, "ok": True},
            {"key": "con", "name": "反对方", "run_id": con_r1, "ok": True},
        ],
        "clashes": [
            {
                "from_key": "con",
                "to_key": "pro",
                "point": "收益可量化但未对冲风险敞口，量化口径回避了尾部风险。",
            },
        ],
        # 第 1 轮无前序边界 ⇒ 无用户追问（载荷形状统一，恒带空列表）。
        "user_interjections": [],
        # 记分裁判（P2）：首轮各方咬合但未见底，支持方量化更实、小幅领先（净分 9 : 8）。
        "scores": {
            "pro": {
                "argument": 4, "engagement": 2, "evidence": 3,
                "penalties": [], "note": "收益量化扎实，但尚未正面接住风险兜底。", "total": 9,
            },
            "con": {
                "argument": 3, "engagement": 3, "evidence": 2,
                "penalties": [], "note": "风险敞口命门抓得准，缺量化证据。", "total": 8,
            },
        },
    }
    round2_payload = {
        "round_no": 2,
        "focus": "灰度期数据口径不一致时的兜底机制",
        "summary": "支持方正面回应追问：灰度期以反对方数据口径为准并设熔断；分歧收敛到阈值该如何设。",
        "verdict": {
            "real_clash": True,
            "new_arguments": True,
            "converged": False,
            "stop_reason": "",
            "rationale": "支持方接住追问、给出兜底，但回滚/熔断阈值该多严仍有实质分歧，值得再探一轮。",
        },
        "sides": [
            {"key": "pro", "name": "支持方", "run_id": pro_r2, "ok": True},
            {"key": "con", "name": "反对方", "run_id": con_r2, "ok": True},
        ],
        "clashes": [
            {
                "from_key": "con",
                "to_key": "pro",
                "point": "以反对方口径为准虽稳妥，但熔断阈值过松仍可能放大尾部风险。",
            },
        ],
        # 用户在第 1 轮边界向【支持方】追问、本轮承接回应（verbatim 复盘单元）。
        "user_interjections": [
            {
                "ask": "灰度期如果出现数据口径不一致，谁来兜底、按谁的口径？",
                "target_key": "pro",
                "answered": True,
            },
        ],
        # 记分裁判（P2）：胜负手拉开轮——支持方正面接住追问、给出灰度兜底（回应完整度跳到 4），反对方
        # 回避了成本归属被扣分（净分 11 : 7）。
        "scores": {
            "pro": {
                "argument": 4, "engagement": 4, "evidence": 3,
                "penalties": [], "note": "正面接住追问、给出保守口径 + 熔断兜底。", "total": 11,
            },
            "con": {
                "argument": 3, "engagement": 3, "evidence": 2,
                "penalties": ["回避了灰度兜底的成本归属"],
                "note": "仍质疑熔断阈值，但对成本归属避而不答。", "total": 7,
            },
        },
    }
    round3_payload = {
        "round_no": 3,
        "focus": "回滚与熔断阈值该如何设定",
        "summary": "支持方提出按尾部损失分位设阈并自动回滚，反对方认可机制、仅保留阈值取值分歧，收敛到价值取舍。",
        "verdict": {
            "real_clash": True,
            "new_arguments": False,
            "converged": True,
            "stop_reason": "兜底机制已谈透，仅剩阈值取值这一价值判断需用户拍板。",
            "rationale": "阈值机制双方达成一致，取值严松是风险偏好取舍、AI 判不了，交用户拍板。",
        },
        "sides": [
            {"key": "pro", "name": "支持方", "run_id": pro_r3, "ok": True},
            {"key": "con", "name": "反对方", "run_id": con_r3, "ok": True},
        ],
        "clashes": [
            {
                "from_key": "con",
                "to_key": "pro",
                "point": "按分位设阈方向对，但分位取多少直接决定放行多少尾部风险，仍需拍板。",
            },
        ],
        # 第 3 轮无新的用户追问（载荷形状统一，恒带空列表）。
        "user_interjections": [],
        # 记分裁判（P2）：收敛轮——阈值机制达成一致、双方势均力敌（净分 10 : 10），仅剩阈值取值待拍板。
        "scores": {
            "pro": {
                "argument": 3, "engagement": 4, "evidence": 3,
                "penalties": [], "note": "按分位设阈 + 自动回滚，机制落地。", "total": 10,
            },
            "con": {
                "argument": 3, "engagement": 4, "evidence": 3,
                "penalties": [], "note": "认可机制，保留阈值取值分歧。", "total": 10,
            },
        },
    }
    debate_payload = {
        "form": "debate",
        "motion": "是否采用方案 A",
        "stop_reason": "converged",
        "narrative_first": False,
        "sides": [
            {
                "key": "pro",
                "name": "支持方",
                "stance": "支持采用方案 A",
                "is_subject": False,
            },
            {
                "key": "con",
                "name": "反对方",
                "stance": "反对采用方案 A",
                "is_subject": False,
            },
        ],
        "rounds": [round1_payload, round2_payload, round3_payload],
        "brief": {
            "crux": "方案 A 的风险是否可控、灰度兜底是否到位",
            "strongest_points": {
                "pro": "收益显著且可量化，已就追问给出灰度兜底（保守口径 + 熔断 + 按分位设阈自动回滚）",
                "con": "风险敞口缺乏兜底，熔断阈值仍可能过松",
            },
            "factual_disputes": ["历史故障率的数据口径不一致"],
            "value_disputes": ["增长优先 vs 稳健优先"],
            # 胜负手（P2）：据逐轮记分累计（净分 30 : 25）——胜负手在第 2 轮拉开。
            "decisive": "胜负手在第 2 轮：支持方正面接住你的追问、给出灰度兜底（回应完整度跳升），反对方却回避成本归属被扣分；第 3 轮双方就阈值机制达成一致。累计净分 30 : 25，支持方占优，仅剩阈值取值是价值取舍。",
            "leaning": "倾向有条件采用",
            "confidence": "medium",
            "recommendation": "采纳支持方的灰度兜底方案（按分位设阈 + 自动回滚），阈值取值需你拍板。",
            # 用户追问已被回应、但仅剩的阈值取舍上交用户拍板（追问不石沉大海）。
            "open_questions": ["灰度的回滚/熔断阈值取多少（你的追问已促成兜底，取值仍需你定）？"],
        },
    }
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("我发起一场可追问的正反辩论来定夺。"),
        run_plan(
            execution_id="exec1",
            plan_type="debate",
            task_summary="正反辩论（可追问）：是否采用方案 A",
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
        run_started(pro_r1, "d_pro", parent_run_id=mod),
        run_output_delta(pro_r1, "d_pro", "支持理由：收益可量化。"),
        run_completed(
            pro_r1,
            "d_pro",
            output_summary="支持方陈述完成",
            duration_ms=800,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(con_r1, "d_con", parent_run_id=mod),
        run_output_delta(con_r1, "d_con", "反对理由：风险无兜底。"),
        run_completed(
            con_r1,
            "d_con",
            output_summary="反对方陈述完成",
            duration_ms=850,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        # 第 2 轮：辩手 continue revision（parent=首轮 run，revision=2）回应用户追问。乙 wire
        # 携 round/stance：修订 run_started 携 stance/group + 真实 round=2，三端 fold 投到修订
        # 节点上（单一轮次投影）。
        run_started(
            pro_r2, pro_r2, parent_run_id=pro_r1, revision=2,
            stance="pro", group="debate:debate", round_no=2,
        ),
        # 续写轮收到的上下文（本轮焦点 + 用户追问 + 对方上轮论点）——修订节点面板据此填充，不再空白。
        run_context(
            pro_r2,
            pro_r2,
            [
                _ctx_block("round_focus", "第 2 轮 · 本轮焦点", "灰度期的兜底与熔断机制"),
                _ctx_block(
                    "interjection",
                    "用户本轮追问（向你提出 · 最高优先级）",
                    "- 灰度期谁来兜底？",
                ),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 反方",
                    "反对理由：风险无兜底。",
                    source_role="反方",
                    source_run_id=con_r1,
                ),
            ],
        ),
        run_output_delta(pro_r2, pro_r2, "回应追问：灰度以保守口径为准并设熔断。"),
        run_completed(
            pro_r2,
            pro_r2,
            output_summary="支持方回应追问完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(
            con_r2, con_r2, parent_run_id=con_r1, revision=2,
            stance="con", group="debate:debate", round_no=2,
        ),
        run_context(
            con_r2,
            con_r2,
            [
                _ctx_block("round_focus", "第 2 轮 · 本轮焦点", "灰度期的兜底与熔断机制"),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 正方",
                    "支持理由：收益可量化。",
                    source_role="正方",
                    source_run_id=pro_r1,
                ),
                _ctx_block(
                    "challenge",
                    "上一轮你被反驳的命门",
                    "- 正方：收益可量化，风险可用熔断兜底，并非无解。",
                ),
            ],
        ),
        run_output_delta(con_r2, con_r2, "仍存疑：熔断阈值过松。"),
        run_completed(
            con_r2,
            con_r2,
            output_summary="反对方续论完成",
            duration_ms=830,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        # 第 3 轮：再续写一轮（revision=3 / round=3）。续写 parent 恒为【原始首轮 run】
        # （session.run_id 跨轮不变）——修订是绕原始的「星」，revisionOf 全指向 pro_r1；图层据
        # revision 排序把星铺成 原始→v2→v3 的链，验多轮不塌成 2 版本。
        run_started(
            pro_r3, pro_r3, parent_run_id=pro_r1, revision=3,
            stance="pro", group="debate:debate", round_no=3,
        ),
        run_context(
            pro_r3,
            pro_r3,
            [
                _ctx_block("round_focus", "第 3 轮 · 本轮焦点", "熔断阈值如何取值"),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 反方",
                    "仍存疑：熔断阈值过松。",
                    source_role="反方",
                    source_run_id=con_r2,
                ),
            ],
        ),
        run_output_delta(pro_r3, pro_r3, "收敛：按尾部损失分位设阈并自动回滚。"),
        run_completed(
            pro_r3,
            pro_r3,
            output_summary="支持方第三轮收敛完成",
            duration_ms=810,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_started(
            con_r3, con_r3, parent_run_id=con_r1, revision=3,
            stance="con", group="debate:debate", round_no=3,
        ),
        run_context(
            con_r3,
            con_r3,
            [
                _ctx_block("round_focus", "第 3 轮 · 本轮焦点", "熔断阈值如何取值"),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 正方",
                    "回应追问：灰度以保守口径为准并设熔断。",
                    source_role="正方",
                    source_run_id=pro_r2,
                ),
            ],
        ),
        run_output_delta(con_r3, con_r3, "认可机制，仅阈值取值仍需拍板。"),
        run_completed(
            con_r3,
            con_r3,
            output_summary="反对方第三轮收敛完成",
            duration_ms=820,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        run_completed(
            mod,
            mod,
            output_summary="灰度兜底已达成，仅剩阈值取值待你拍板",
            duration_ms=2800,
            role="主持人",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        debate_result(execution_id="exec1", moderator_run_id=mod, payload=debate_payload),
        message_end(FinishReason.END_TURN, input_tokens=3600, output_tokens=620, cost=_COST),
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
        # 乙 wire 携 round/stance（多方无 stance）：续写携 group + 真实 round=2，三端 fold 投到
        # 修订节点上，debateLiveRounds 据 round 而非版本号铺轮次（单一轮次投影）。
        run_started(
            r2a, "rt_a2", parent_run_id=r1a, revision=2,
            group="debate:roundtable", round_no=2,
        ),
        # 圆桌续写轮：焦点 + 其余各方上轮论点（多方无 stance，opponent = 除本方外的每一方）。
        run_context(
            r2a,
            "rt_a2",
            [
                _ctx_block("round_focus", "第 2 轮 · 本轮焦点", "三方就『问责机制』正面交锋"),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 监管视角",
                    "监管视角：问责缺位才是关键。",
                    source_role="监管视角",
                    source_run_id=r1b,
                ),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 产业视角",
                    "产业视角：别忽视落地成本。",
                    source_role="产业视角",
                    source_run_id=r1c,
                ),
            ],
        ),
        run_output_delta(r2a, "rt_a2", "技术视角续：问责需可观测性支撑。"),
        run_started(
            r2b, "rt_b2", parent_run_id=r1b, revision=2,
            group="debate:roundtable", round_no=2,
        ),
        run_context(
            r2b,
            "rt_b2",
            [
                _ctx_block("round_focus", "第 2 轮 · 本轮焦点", "三方就『问责机制』正面交锋"),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 技术视角",
                    "技术视角：能力外溢是根因。",
                    source_role="技术视角",
                    source_run_id=r1a,
                ),
                _ctx_block(
                    "opponent",
                    "对方上一轮 · 产业视角",
                    "产业视角：别忽视落地成本。",
                    source_role="产业视角",
                    source_run_id=r1c,
                ),
            ],
        ),
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
    "multi_agent_debate_followup": ("多 Agent：辩论收场带用户追问（user_interjections verbatim 复盘）", _multi_agent_debate_followup),
    "multi_agent_roundtable_rounds": ("多 Agent：圆桌逐轮增量（debate_round_started/debate_round）+ 续写 revision + 中途取消", _multi_agent_roundtable_rounds),
    "multi_agent_red_team": ("多 Agent：红队审查收场（form=red_team）风险看板 + 加固建议 + 方案方回应双产物", _multi_agent_red_team),
    "multi_agent_roundtable_settled": ("多 Agent：圆桌探讨收场（form=roundtable）观点光谱英雄区 + 叙事后简报小结双产物", _multi_agent_roundtable_settled),
}
