"""Red-team review conformance vector."""

from __future__ import annotations

from agentcore.runtime.events import (
    FinishReason,
    SSEEvent,
    content_delta,
    debate_result,
    debate_round_started,
    message_end,
    message_start,
    run_completed,
    run_output_delta,
    run_plan,
    run_started,
)

from .._common import _CONV, _COST, _USAGE
from ._builders import _moderator_agents_runs


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
    mod_agents, mod_runs = _moderator_agents_runs(
        mod, cap, "主持红队审查：压测「自建鉴权服务」方案"
    )
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
                    {"key": "subject", "name": "方案方", "run_id": subj_run, "ok": True, "absent": False, "arguments": []},
                    {"key": "red1", "name": "安全红队", "run_id": red1_run, "ok": True, "absent": False, "arguments": []},
                    {"key": "red2", "name": "合规红队", "run_id": red2_run, "ok": True, "absent": False, "arguments": []},
                    {"key": "red3", "name": "运维红队", "run_id": red3_run, "ok": True, "absent": False, "arguments": []},
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
            "handoffs": [
                {"kind": "value", "text": "把鉴权握在自己手里的掌控感 vs 外采省心"},
                {"kind": "fact", "text": "自建 vs 外采的真实合规改造工作量缺乏一致口径"},
                {"kind": "question", "text": "密钥轮换的运维归属谁？"},
            ],
            "leaning": "有条件通过：先补 3 项加固再上线",
            "confidence": "medium",
            "recommendation": "上线前必须：① 刷新令牌轮换 + 设备绑定 ② 登录限速与异常告警 ③ 第三方渗透测试。",
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
        debate_round_started(
            execution_id="exec1",
            moderator_run_id=mod,
            round_no=1,
            focus="凭证存储与会话固定的攻击面",
            cross_exam_enabled=True,
            opening="红队开场：先压测凭证存储与会话固定。",
        ),
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
