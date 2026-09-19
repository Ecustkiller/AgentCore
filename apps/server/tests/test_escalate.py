"""EscalateTool logging — ``worker.escalate`` records「为什么升级」(question + assumption).

决策可观测回归：``worker.escalate`` used to carry only ``run_id`` / ``blocking`` / ``kind`` /
``has_assumption`` — i.e. that AN escalation happened and its type, but never its substance.
Now it also logs ``question`` (the待决问题原文, preview-capped) and ``assumption`` (the超时
回落), so an offline analysis of the product-AI logs can read WHY a worker escalated and where
it was blocked, straight from the line — no DB round-trip. These drive the non-blocking path
(no live escalation channel), which still emits the log before returning its CONTINUE ack.
"""

import json
from pathlib import Path

import pytest

import agentcore.tools.builtin.escalate as escalate_mod
from agentcore.runtime.events.interaction import escalation_required
from agentcore.tools.builtin.escalate import EscalateTool
from agentcore.tools.protocol import EscalationChannel, EscalationOutcome, ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace
from tests.conftest import LogSpy


def test_escalate_schema_has_no_recommended_field():
    props = (
        EscalateTool()
        .schema.parameters["properties"]["questions"]["items"]["properties"]["options"]["items"][
            "properties"
        ]
    )
    assert "recommended" not in props
    assert "（推荐）" not in props["label"]["description"]
    assert "放第一" not in props["label"]["description"]


def _ctx() -> ToolContext:
    # No escalation channel / on_escalate callback → the non-blocking escalate path, which
    # still emits worker.escalate before returning the "proceed on your assumption" ack.
    return ToolContext.create(
        execution_id="e",
        run_id="w1",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


async def test_worker_escalate_logs_question_and_assumption(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(escalate_mod, "logger", spy)

    result = await EscalateTool().execute(
        {"question": "该走方案A还是方案B?", "assumption": "暂按方案A继续", "kind": "scope"},
        _ctx(),
    )

    assert result.success is True  # non-blocking escalate never stops the worker
    esc = spy.get("worker.escalate")
    assert esc["run_id"] == "w1"
    assert esc["kind"] == "scope"
    assert esc["blocking"] is False
    assert esc["has_assumption"] is True
    # the WHY + the fallback — the substance the enrichment adds
    assert esc["question"] == "该走方案A还是方案B?"
    assert esc["assumption"] == "暂按方案A继续"


async def test_worker_escalate_question_preview_is_capped(monkeypatch):
    # A long question is clipped to a bounded preview (铁律: never the full 正文); no
    # assumption given → the assumption preview is empty (blocking defaults false, so an
    # assumption is not required).
    spy = LogSpy()
    monkeypatch.setattr(escalate_mod, "logger", spy)

    await EscalateTool().execute({"question": "为" * 500}, _ctx())

    esc = spy.get("worker.escalate")
    assert esc["question"].endswith("…")
    assert len(esc["question"]) == 201  # 200-char cap + the one ellipsis char
    assert esc["has_assumption"] is False
    assert esc["assumption"] == ""


def test_escalation_required_carries_timeout_only_when_ops_configured_one():
    """诚实性：默认部署无超时 ⇒ 字段缺席，卡面不得承诺「未答则按假设继续」。"""
    default_deploy = escalation_required(
        "r1",
        "a1",
        escalation_id="e1",
        question="该走哪个方案?",
        assumption="暂按 A",
        timeout_seconds=None,
    )
    assert "timeout_seconds" not in default_deploy.payload

    with_ceiling = escalation_required(
        "r1",
        "a1",
        escalation_id="e1",
        question="该走哪个方案?",
        assumption="暂按 A",
        timeout_seconds=1800.0,
    )
    assert with_ceiling.payload["timeout_seconds"] == 1800.0


def test_escalate_schema_teaches_blocking_choice():
    """Worker 按题自选 blocking：默认 false / 猜错作废只留 blocking 参数。"""
    schema = EscalateTool().schema
    desc = schema.description
    assert "必须由上级" in desc or "拍板" in desc
    assert "小事勿升级" not in desc
    assert "报一声" in desc
    assert "猜错作废" in desc
    assert "勿自己改" not in desc
    assert "勿只标假设" not in desc
    assert "默认 false" not in desc
    assert "kind：" not in desc
    kind = schema.parameters["properties"]["kind"]["description"]
    assert "别硬猜" not in kind
    blocking = schema.parameters["properties"]["blocking"]["description"]
    assert "默认 false" in blocking
    assert "报一声继续" in blocking or "原地等" in blocking
    assert "已拒凭据" in blocking and "false" in blocking
    # 身份段整句不进按钮
    assert "挂起等密钥" not in blocking
    assert "已明确拒绝已有凭据" not in blocking
    # default philosophy unchanged: missing blocking stays non-blocking
    assert schema.parameters["properties"]["blocking"].get("default") in (None, False)


def test_escalate_schema_stays_off_engine_internals():
    """协调模式 / 超时 / 未武装 是引擎行为，不写进按钮。"""
    schema = EscalateTool().schema
    blob = schema.description + json.dumps(schema.parameters, ensure_ascii=False)
    for phrase in ("协调模式", "经典路径", "near-verbatim", "未武装", "并发满"):
        assert phrase not in blob, phrase


def test_escalate_schema_options_are_one_line():
    """填卡 HOW 在 ask_user；escalate 按钮不抄权衡/推荐。"""
    props = (
        EscalateTool()
        .schema.parameters["properties"]["questions"]["items"]["properties"]["options"]["items"][
            "properties"
        ]
    )
    assert "detail" not in props
    blob = json.dumps(EscalateTool().schema.parameters, ensure_ascii=False)
    assert "第二句" not in blob
    assert "权衡写进" not in blob
    assert "（推荐）" not in blob


def test_escalate_questions_share_ask_user_card_shape():
    """卡形单源：键与 ask_user 相同；队员不广告本机 action；必填/minItems 仍分列。"""
    from agentcore.runtime.events import EventSink
    from agentcore.tools.builtin.ask_user import AskUserTool

    ask = AskUserTool(
        sink=EventSink(),
        conversation_id="c1",
        timeout_seconds=30.0,
    ).schema.parameters["properties"]["questions"]
    esc = EscalateTool().schema.parameters["properties"]["questions"]
    assert set(esc["items"]["properties"]) == set(ask["items"]["properties"])
    assert set(esc["items"]["properties"]) == {
        "prompt",
        "kind",
        "options",
        "multiple",
    }
    assert "action" not in esc["items"]["properties"]["options"]["items"]["properties"]
    assert "action" not in ask["items"]["properties"]["options"]["items"]["properties"]
    assert ask.get("minItems") == 1
    assert "minItems" not in esc
    assert "required" not in esc
    desktop = AskUserTool(
        sink=EventSink(),
        conversation_id="c1",
        timeout_seconds=30.0,
        advertise_bind_local_folder=True,
    ).schema.parameters["properties"]["questions"]["items"]["properties"]["options"]["items"][
        "properties"
    ]
    assert "action" in desktop
    assert "action" not in esc["items"]["properties"]["options"]["items"]["properties"]


@pytest.mark.asyncio
async def test_blocking_escalate_drops_option_detail():
    seen: dict = {}

    async def _request(q, a, questions, kind, awaiting="user", **kwargs):
        seen["questions"] = questions
        return EscalationOutcome(status="resolved", answer="方案A")

    ctx = ToolContext.create(
        execution_id="e",
        run_id="w1",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
        conversation_id="c1",
        escalation=EscalationChannel(armed=True, request=_request),
    )
    result = await EscalateTool().execute(
        {
            "question": "该走哪个方案?",
            "assumption": "暂按方案A继续",
            "blocking": True,
            "questions": [
                {
                    "prompt": "选一个方案",
                    "options": [
                        {"label": "方案A：先出契约", "detail": "慢但稳"},
                        {"label": "方案B：先一条主路径", "detail": "快但窄"},
                    ],
                }
            ],
        },
        ctx,
    )
    assert result.success is True
    opts = seen["questions"][0]["options"]
    assert [o["label"] for o in opts] == ["方案A：先出契约", "方案B：先一条主路径"]
    assert all("detail" not in o for o in opts)


@pytest.mark.asyncio
async def test_bracketed_recommendation_label_reaches_the_escalation_card():
    """Tendency markup in the option name is accepted; the card still opens."""
    seen: dict = {}

    async def _request(q, a, questions, kind, awaiting="user", **kwargs):
        seen["questions"] = questions
        return EscalationOutcome(status="resolved", answer="选方案A（推荐）")

    ctx = ToolContext.create(
        execution_id="e",
        run_id="w1",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
        conversation_id="c1",
        escalation=EscalationChannel(armed=True, request=_request),
    )
    result = await EscalateTool().execute(
        {
            "question": "该走哪个方案?",
            "assumption": "暂按方案A继续",
            "blocking": True,
            "questions": [
                {
                    "id": "plan",
                    "prompt": "选一个方案",
                    "options": [
                        {"id": "a", "label": "方案A（推荐）"},
                        {"id": "b", "label": "方案B"},
                    ],
                }
            ],
        },
        ctx,
    )

    assert result.success is True
    assert seen["questions"][0]["options"][0]["label"] == "方案A（推荐）"
    assert "recommended" not in seen["questions"][0]["options"][0]


@pytest.mark.asyncio
async def test_clean_labels_still_reach_the_escalation_card():
    """Bare「推荐」in a product name is not tendency markup; the card still opens."""
    seen: dict = {}

    async def _request(q, a, questions, kind, awaiting="user", **kwargs):
        seen["questions"] = questions
        return EscalationOutcome(status="resolved", answer="选方案A")

    ctx = ToolContext.create(
        execution_id="e",
        run_id="w1",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
        conversation_id="c1",
        escalation=EscalationChannel(armed=True, request=_request),
    )
    result = await EscalateTool().execute(
        {
            "question": "该走哪个方案?",
            "assumption": "暂按方案A继续",
            "blocking": True,
            "questions": [
                {
                    "id": "plan",
                    "prompt": "选一个方案",
                    "options": [
                        {"id": "a", "label": "推荐算法重写"},
                        {"id": "b", "label": "方案B"},
                    ],
                }
            ],
        },
        ctx,
    )

    assert result.success is True
    assert seen["questions"][0]["options"][0]["label"] == "推荐算法重写"
