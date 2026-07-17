"""A2 出处软校验自测（per-PR 零真实 LLM）。

验收面：
1. 匹配器契约：写法差异不误杀（宽松匹配）、凭空来源拦截（严格兜底）、短出处 / 3-gram 概括
   写法 / 待核实标记不参检；
2. 管线契约：opening / 续辩 / 质询作答成稿的【已核实·X】对不上检索语料 → 回炉一次
   （reset + [系统提示] 反馈）；二次违规放行；本方 assistant 旧发言不算语料（不能自我洗白）；
3. 装配契约：debater_task payload 携 ``source_grounding_check=True``（opening 经 RunSpec 链路）。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path

from agentcore.llm.profiles import ProfileParams
from agentcore.llm.provider.protocol import LLMChunk, LLMMessage, LLMResponse, TokenUsage
from agentcore.runtime.debate import DebateConfig, DebateForm, DebateSide, RoundPolicy
from agentcore.runtime.debate.evidence_guard import (
    format_source_grounding_steer,
    is_source_grounded,
    normalize_evidence_text,
    ungrounded_verified_tags,
)
from agentcore.runtime.debate.prompt import debater_task
from agentcore.runtime.debate.speech_pipeline import research_then_draft
from agentcore.runtime.events.types import EventType
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

# ── 匹配器契约 ────────────────────────────────────────────────────────────────


def test_variant_spelling_is_grounded():
    """写法差异不误杀：标签「腾讯新闻2026年7月3日报道」vs 笔记「腾讯新闻 2026-07-03」。"""
    corpus = normalize_evidence_text("笔记：腾讯新闻 2026-07-03 报道称一审判赔 500 万。")
    assert is_source_grounded("腾讯新闻2026年7月3日报道", corpus)


def test_fabricated_source_is_ungrounded():
    """凭空来源拦截：检索记录中无迹可循的「街访数据」（lv-molihua 结辩幻觉实例同款）。"""
    corpus = normalize_evidence_text(
        "笔记：2024 年报披露营收 12 亿【已核实·2024年报】；判决书要点若干。"
    )
    assert not is_source_grounded("街访数据", corpus)
    # 语料中「数据」类泛词不足以给「街访数据」洗白
    assert not is_source_grounded("街访数据", normalize_evidence_text("行业数据报告显示……"))


def test_short_source_needs_whole_containment():
    corpus = normalize_evidence_text("据年报披露……")
    assert is_source_grounded("年报", corpus)
    assert not is_source_grounded("蓝皮书", corpus)


def test_cjk_trigram_tolerates_summarized_spelling():
    """概括写法：标签「新华社速报」vs 语料只有「新华社」→ 3-gram 命中，不误杀。"""
    corpus = normalize_evidence_text("新华社消息：案件已受理。")
    assert is_source_grounded("新华社速报", corpus)


def test_punctuation_only_source_passes():
    """归一化后为空的怪异出处不判（宁可漏报不可误杀）。"""
    assert is_source_grounded("……", normalize_evidence_text("任何语料"))


def test_ungrounded_verified_tags_ignores_pending_markers():
    """只查【已核实】；【待核实·推断】不参检。"""
    speech = "主张 A【待核实·推断】；主张 B【已核实·街访数据】。"
    out = ungrounded_verified_tags(speech, "笔记里没有那个出处")
    assert out == ["【已核实·街访数据】"]


def test_source_grounding_steer_copy():
    steer = format_source_grounding_steer(["【已核实·街访数据】"])
    assert steer.startswith("[系统提示]")
    assert "【已核实·街访数据】" in steer
    assert "待核实" in steer
    assert format_source_grounding_steer([]) == ""


# ── 管线契约 ────────────────────────────────────────────────────────────────


@dataclass
class _FakeSink:
    events: list = field(default_factory=list)

    def emit(self, event) -> None:  # noqa: ANN001
        self.events.append(event)


class _SequenceDraftLLM:
    """按调用次序返回成稿正文（复用结辩闸测试的回炉驱动方式）。"""

    def __init__(self, speeches: list[str]) -> None:
        self.speeches = list(speeches)
        self.stream_calls = 0
        self.last_user = ""

    async def complete(self, request):  # noqa: ANN001
        return LLMResponse(
            content=self.speeches[min(self.stream_calls, len(self.speeches) - 1)]
        )

    async def stream(self, request):  # noqa: ANN001
        speech = self.speeches[min(self.stream_calls, len(self.speeches) - 1)]
        self.stream_calls += 1
        self.last_user = request.messages[1].content or ""
        yield LLMChunk(delta_content=speech)
        yield LLMChunk(
            finish_reason="stop", usage=TokenUsage(input_tokens=10, output_tokens=5)
        )


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="r1",
        agent_id="r1",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _run_pipeline(
    llm: _SequenceDraftLLM,
    sink: _FakeSink,
    messages: list[LLMMessage],
    *,
    draft_brief: str = "请输出本轮完整发言。",
) -> tuple[str, int]:
    speech, _reasoning, _usage, rounds = asyncio.run(
        research_then_draft(
            messages,
            llm=llm,
            tools=ToolRegistry(),
            sink=sink,  # type: ignore[arg-type]
            tool_ctx=_ctx(),
            profile=ProfileParams(temperature=0.4, max_rounds=4, name="agent.strong"),
            turn_model="fake",
            allowed_tools=[],
            run_id="r2_pro",
            agent_id="r2_pro",
            citation_sink=[],
            approval_gate=None,
            draft_system="成稿",
            draft_brief=draft_brief,
            allow_research=True,
            check_source_grounding=True,
        )
    )
    return speech, rounds


def _resets(sink: _FakeSink) -> list:
    return [e for e in sink.events if e.type is EventType.RUN_OUTPUT_RESET]


def test_grounded_speech_passes_without_rework():
    """出处与检索语料（user 消息 / brief）对得上 → 一次成稿、零回炉。"""
    llm = _SequenceDraftLLM(
        [
            "### 侵权成立\n一审判赔 500 万【已核实·腾讯新闻2026年7月3日报道】，"
            "营收口径见【已核实·2024年报】。"
        ]
    )
    sink = _FakeSink()
    messages = [
        LLMMessage(role="system", content="你是辩手"),
        LLMMessage(
            role="user",
            content="检索记录：腾讯新闻 2026-07-03 报道称一审判赔 500 万；2024 年报披露营收 12 亿。",
        ),
    ]
    speech, rounds = _run_pipeline(llm, sink, messages)
    assert llm.stream_calls == 1
    assert rounds == 1
    assert not _resets(sink)
    assert "【已核实·2024年报】" in speech


def test_fabricated_source_reworks_once_then_passes():
    """凭空来源 → reset + [系统提示] 回炉一次；修正稿放行。"""
    llm = _SequenceDraftLLM(
        [
            "### 民意支持\n38% 受访者认同【已核实·街访数据】。",
            "### 侵权成立\n一审判赔 500 万【已核实·2024年报】。",
        ]
    )
    sink = _FakeSink()
    messages = [
        LLMMessage(role="system", content="你是辩手"),
        LLMMessage(role="user", content="检索记录：2024 年报披露营收 12 亿。"),
    ]
    speech, rounds = _run_pipeline(llm, sink, messages)
    assert llm.stream_calls == 2
    assert rounds == 2
    assert "【已核实·街访数据】" not in speech
    resets = _resets(sink)
    assert len(resets) == 1
    assert resets[0].payload.get("reason") == "finish_guard"
    assert "[系统提示]" in llm.last_user
    assert "【已核实·街访数据】" in llm.last_user


def test_second_violation_passes_through():
    """回炉后仍违规 → 放行第二稿（不第三次调用）。"""
    bad = "### 民意支持\n38% 受访者认同【已核实·街访数据】。"
    llm = _SequenceDraftLLM([bad, bad])
    sink = _FakeSink()
    messages = [
        LLMMessage(role="system", content="你是辩手"),
        LLMMessage(role="user", content="检索记录：2024 年报披露营收 12 亿。"),
    ]
    speech, rounds = _run_pipeline(llm, sink, messages)
    assert llm.stream_calls == 2
    assert rounds == 2
    assert speech == bad
    assert len(_resets(sink)) == 1


def test_own_prior_speech_does_not_self_whitelist():
    """语料只算 user / tool 消息与笔记——本方旧 assistant 发言提过的凭空出处不能自我洗白。"""
    llm = _SequenceDraftLLM(
        [
            "### 民意支持\n38% 受访者认同【已核实·街访数据】。",
            "### 收束\n营收口径见【已核实·2024年报】。",
        ]
    )
    sink = _FakeSink()
    messages = [
        LLMMessage(role="system", content="你是辩手"),
        LLMMessage(role="user", content="检索记录：2024 年报披露营收 12 亿。"),
        LLMMessage(role="assistant", content="上一轮我提过街访数据支持我方。"),
    ]
    _speech, _rounds = _run_pipeline(llm, sink, messages)
    assert llm.stream_calls == 2
    assert len(_resets(sink)) == 1


def test_draft_brief_counts_as_corpus():
    """成稿 brief（含底料 / 材料块）里的出处算数——引用被喂的材料不算凭空。"""
    llm = _SequenceDraftLLM(["### 风险可控\n预案完备【已核实·灰度预案v2】。"])
    sink = _FakeSink()
    messages = [LLMMessage(role="system", content="你是辩手")]
    _speech, _rounds = _run_pipeline(
        llm, sink, messages, draft_brief="案件底料：灰度预案 v2 已核验。请立论。"
    )
    assert llm.stream_calls == 1
    assert not _resets(sink)


# ── 装配契约 ────────────────────────────────────────────────────────────────


def test_debater_task_payload_arms_source_grounding():
    """opening 经 RunSpec 链路装配：payload 携 source_grounding_check=True。"""
    config = DebateConfig(
        motion="该不该做 X",
        form=DebateForm.DEBATE,
        sides=[
            DebateSide(key="pro", name="正方", stance="支持"),
            DebateSide(key="con", name="反方", stance="反对"),
        ],
        policy=RoundPolicy(thorough=True, max_rounds=5),
    )
    payload = debater_task(config, config.sides[0], 0, round_no=1, focus="成本")
    assert payload["source_grounding_check"] is True
    assert payload["research_then_draft"] is True
