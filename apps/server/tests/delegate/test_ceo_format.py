"""CEO synthesis input formatting tests."""

from structlog.testing import capture_logs

from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState
from agentcore.tools.builtin.delegate import _DELEGATE_OUTPUT_LIMIT

from tests.delegate.conftest import Provider, tool


def test_format_for_ceo_surfaces_file_manifest_and_skip_filelist_hint():
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="建仪表盘", role="前端工程师")])
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED,
            content="已完成仪表盘",
            files_touched=["dashboard.html", "assets/styles.css"],
        )
    }
    out = t._format_for_ceo(plan, results)
    assert "文件产出（已写入工作区）" in out
    assert "`dashboard.html`" in out
    assert "`assets/styles.css`" in out
    assert "无需再用 file_list" in out


def test_format_for_ceo_omits_manifest_when_worker_touched_no_files():
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="查资料", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="一段研究综述")}
    out = t._format_for_ceo(plan, results)
    assert "> 文件产出" not in out


def test_format_for_ceo_footer_guards_against_claiming_unwritten_files():
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="建文件", role="工程师")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="我已创建 app.py 并写入代码")}
    out = t._format_for_ceo(plan, results)
    assert "防幻觉" in out
    assert "未真正写入" in out
    assert "未达成" in out
    assert "属正常" in out


def test_format_for_ceo_surfaces_escalations_blockers_first():
    t = tool(Provider([]))
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="w1", task="查行情", role="调研"),
            RunSpec(run_id="w2", task="建后端", role="后端"),
        ]
    )
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED,
            content="软的备注",
            escalations=[{"question": "目标受众是谁?", "assumption": "暂按大众", "blocking": False}],
        ),
        "w2": RunState(
            phase=RunPhase.COMPLETED,
            content="后端骨架",
            escalations=[{"question": "用 Postgres 还是 MySQL?", "assumption": "暂用 PG", "blocking": True}],
        ),
    }
    out = t._format_for_ceo(plan, results)
    assert "队员升级了待决问题" in out
    assert "用 Postgres 还是 MySQL?" in out and "目标受众是谁?" in out
    assert "其暂用假设：暂用 PG" in out
    assert "【关键阻塞】" in out
    assert out.index("Postgres") < out.index("目标受众")
    assert "ask_user" in out and "revise" in out
    assert "已升级 1 项待决问题" in out


def test_format_for_ceo_no_escalation_section_when_none():
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="查资料", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="一段综述")}
    out = t._format_for_ceo(plan, results)
    assert "队员升级了待决问题" not in out


def test_format_for_ceo_digests_file_producer_not_full_content():
    t = tool(Provider([]))
    long_body = "开头摘要。" + ("废" * 5_000) + "结尾独特标记XYZ"
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="写报告", role="撰稿")])
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED, content=long_body, files_touched=["report.md"]
        )
    }
    out = t._format_for_ceo(plan, results)
    assert "`report.md`" in out
    assert "结尾独特标记XYZ" not in out
    assert len(out) < len(long_body)


def test_format_for_ceo_bounds_wide_fanout_keeping_all_workers_and_closing():
    t = tool(Provider([]))
    nodes = [RunSpec(run_id=f"w{i}", task="分析", role=f"分析{i}") for i in range(8)]
    plan = RunPlan(nodes=nodes)
    results = {
        f"w{i}": RunState(
            phase=RunPhase.COMPLETED, content=f"头{i}" + ("数" * 8_000) + f"尾{i}"
        )
        for i in range(8)
    }
    out = t._format_for_ceo(plan, results)
    for i in range(8):
        assert f"run_id: `w{i}`" in out
    assert "防幻觉" in out and "简短概览" in out
    assert len(out) < _DELEGATE_OUTPUT_LIMIT
    assert "中间省略" in out


def test_format_for_ceo_short_prose_passes_through_whole():
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="查资料", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="一段不长的研究综述，结论是甲。")}
    out = t._format_for_ceo(plan, results)
    assert "一段不长的研究综述，结论是甲。" in out
    assert "中间省略" not in out


def test_format_for_ceo_emits_uncapped_synthesis_metric():
    t = tool(Provider([]))
    nodes = [RunSpec(run_id=f"w{i}", task="分析", role=f"分析{i}") for i in range(8)]
    plan = RunPlan(nodes=nodes)
    results = {
        f"w{i}": RunState(phase=RunPhase.COMPLETED, content=f"头{i}" + ("数" * 8_000))
        for i in range(8)
    }
    with capture_logs() as logs:
        t._format_for_ceo(plan, results)
    metric = next(e for e in logs if e["event"] == "delegate.synthesis")
    assert metric["capped"] is False
    assert metric["workers"] == 8 and metric["prose"] == 8
    assert metric["ratio"] < 1.0
