"""辩论双产物工作区落盘（机制性写入 ``debate/``，一场一份）。"""

from __future__ import annotations

from pathlib import Path

from agentcore.runtime.debate import (
    STOP_CONVERGED,
    DebateBrief,
    DebateConfig,
    DebateForm,
    DebateHandoff,
    DebateResult,
    DebateSide,
    JudgeVerdict,
    RoundPolicy,
    RoundResult,
    SideTurn,
)
from agentcore.runtime.debate.persist import (
    artifact_paths,
    artifact_stamp,
    format_artifact_footer,
    persist_debate_artifacts,
    render_debate_file,
)
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.protocol import WorkspaceIOError
from agentcore.workspace.server import ServerWorkspace


def _sides() -> list[DebateSide]:
    return [
        DebateSide(key="pro", name="正方", stance="支持"),
        DebateSide(key="con", name="反方", stance="反对"),
    ]


def _result(*, motion: str = "该不该做 X") -> DebateResult:
    config = DebateConfig(
        motion=motion,
        form=DebateForm.DEBATE,
        sides=_sides(),
        policy=RoundPolicy.for_form(DebateForm.DEBATE),
    )
    rounds = [
        RoundResult(
            round_no=1,
            focus="成本与收益",
            turns=[
                SideTurn(
                    side_key="pro",
                    side_name="正方",
                    run_id="r1_pro",
                    content="正方发言",
                    ok=True,
                ),
                SideTurn(
                    side_key="con",
                    side_name="反方",
                    run_id="r1_con",
                    content="反方发言",
                    ok=True,
                ),
            ],
            verdict=JudgeVerdict(
                real_clash=True,
                new_arguments=False,
                converged=True,
                rationale="已摊开",
            ),
            summary="双方在成本口径上仍有分歧，但路径已清晰。",
        )
    ]
    brief = DebateBrief(
        crux="做不做 X 的核心权衡",
        strongest_points={"pro": "正方最强论点", "con": "反方最强论点"},
        handoffs=[
            DebateHandoff(kind="value", text="你更看重速度还是稳妥"),
            DebateHandoff(kind="fact", text="X 的成本到底多少"),
        ],
        leaning="基于事实反方略稳",
        confidence="中",
        recommendation="先小步验证再决定",
    )
    return DebateResult(
        config=config, rounds=rounds, brief=brief, stop_reason=STOP_CONVERGED
    )


def test_artifact_stamp_from_moderator_run_id():
    assert artifact_stamp("debate_abcdef12-3456-7890-abcd-ef1234567890") == "abcdef12"
    assert artifact_stamp("debate_") == "场次"
    assert artifact_stamp("") == "场次"


def test_artifact_paths_chinese_under_debate_dir():
    paths = artifact_paths(motion="该不该做 X？", stamp="abcd1234")
    assert paths.path.startswith("AgentCore/文档/debate/")
    assert paths.path.endswith(".md")
    assert paths.path.startswith("AgentCore/文档/debate/辩论·")
    assert "该不该做X" in paths.path  # 空白压掉
    assert "abcd1234" in paths.path
    assert paths.as_list() == [paths.path]


def test_render_file_puts_brief_above_narrative():
    result = _result()
    md = render_debate_file(result)
    assert md.startswith("# 辩论")
    assert "基于事实反方略稳" in md
    assert "先小步验证再决定" in md
    assert "成本与收益" in md
    assert "双方在成本口径上仍有分歧" in md
    assert md.index("决策简报") < md.index("交锋叙事线")
    assert "幕1 汇总" not in md


def test_render_file_act1_crosslink_header():
    result = _result()
    md = render_debate_file(
        result, act1_summary_path="AgentCore/文档/research/汇总与命题卡.md"
    )
    assert "**幕1 汇总**：`AgentCore/文档/research/汇总与命题卡.md`" in md


async def test_persist_writes_one_file(tmp_path: Path):
    backend = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox())
    result = _result()
    paths = await persist_debate_artifacts(backend, result, stamp="a1b2c3d4")
    assert paths is not None
    dest = tmp_path / paths.path
    assert dest.is_file()
    text = dest.read_text(encoding="utf-8")
    assert "先小步验证再决定" in text
    assert "成本与收益" in text
    assert "幕1 汇总" not in text
    footer = format_artifact_footer(paths)
    assert paths.path in footer
    debate_dir = tmp_path / "AgentCore" / "文档" / "debate"
    assert len(list(debate_dir.glob("*.md"))) == 1


async def test_persist_act1_crosslink_when_synthesizer_exists(tmp_path: Path):
    research = tmp_path / "AgentCore" / "文档" / "research"
    research.mkdir(parents=True)
    (research / "汇总与命题卡.md").write_text("synth", encoding="utf-8")
    backend = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox())
    paths = await persist_debate_artifacts(backend, _result(), stamp="a1b2c3d4")
    assert paths is not None
    text = (tmp_path / paths.path).read_text(encoding="utf-8")
    assert "**幕1 汇总**：`AgentCore/文档/research/汇总与命题卡.md`" in text


async def test_persist_multi_debate_does_not_clobber(tmp_path: Path):
    backend = ServerWorkspace(root=tmp_path, sandbox=SubprocessSandbox())
    first = await persist_debate_artifacts(
        backend, _result(motion="该不该做 X"), stamp="11111111"
    )
    second = await persist_debate_artifacts(
        backend, _result(motion="该不该做 X"), stamp="22222222"
    )
    assert first is not None and second is not None
    assert first.path != second.path
    assert (tmp_path / first.path).is_file()
    assert (tmp_path / second.path).is_file()
    assert "先小步验证再决定" in (tmp_path / first.path).read_text(encoding="utf-8")
    assert "先小步验证再决定" in (tmp_path / second.path).read_text(encoding="utf-8")


async def test_persist_failure_degrades_without_raising(tmp_path: Path):
    class _Boom(ServerWorkspace):
        async def write(self, path: str, content: str) -> int:
            raise WorkspaceIOError("disk full")

    backend = _Boom(root=tmp_path, sandbox=SubprocessSandbox())
    paths = await persist_debate_artifacts(backend, _result(), stamp="deadbeef")
    assert paths is None
    debate_dir = tmp_path / "AgentCore" / "文档" / "debate"
    assert not debate_dir.exists() or not any(debate_dir.iterdir())
