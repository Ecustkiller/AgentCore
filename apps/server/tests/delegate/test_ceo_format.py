"""CEO synthesis input formatting tests."""

from structlog.testing import capture_logs

from agentcore.runtime.runs.notewall import NOTE_KIND_CLAIM, NOTE_KIND_DECISION, NoteWall
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState
from agentcore.tools.builtin.delegate import _DELEGATE_OUTPUT_LIMIT
from tests.delegate.conftest import Provider, tool


def test_format_for_ceo_surfaces_file_manifest():
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
    assert "地面真相" in out


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
    assert "未真正落盘" in out
    assert "未达成" in out
    assert "属正常" in out


def test_format_for_ceo_includes_goal_verification_and_completion_judgment():
    # 合·验证 4a (docs/03-AI核心/编排器与CEO主Agent.md §收尾即验收 第二道): the synthesis wrap-up tells the CEO
    # to verify the assembled result against the user's original request + each task's
    # expected_output and give an explicit done/not-done judgment (fill genuine gaps via
    # delegate/replan/revise, don't fake done, don't spin) — a layer distinct from per-piece
    # contract and the file 防幻觉 guard.
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="建登录接口", role="后端")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="登录接口已完成")}
    out = t._format_for_ceo(plan, results)
    assert "完工核验" in out
    assert "实质达成" in out
    assert "空转" in out  # the don't-spin-when-done half of the completion judgment


def test_format_for_ceo_includes_semantic_boundary_reconciliation():
    # 合·验证 4b (docs/03-AI核心/编排器与CEO主Agent.md §收尾即验收 第一道): before merging interdependent
    # parallel pieces, the synthesis wrap-up tells the CEO to reconcile the SEAMS — only
    # "do they fit together" (冲突 / 缺口 / 重复), NOT per-piece quality (that's the contract
    # line) — and fix mismatches with revise/replan rather than papering over. It is framed as
    # the ACTIVE version of today's passive "only caught when a worker raises escalate scope".
    t = tool(Provider([]))
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="w1", task="建登录接口", role="后端"),
            RunSpec(run_id="w2", task="建登录页面", role="前端", depends_on=["w1"]),
        ]
    )
    results = {
        "w1": RunState(phase=RunPhase.COMPLETED, content="接口已完成"),
        "w2": RunState(phase=RunPhase.COMPLETED, content="页面已完成"),
    }
    out = t._format_for_ceo(plan, results)
    assert "语义边界对账" in out
    assert "冲突" in out and "缺口" in out and "重复" in out
    assert "糊过去" in out
    # the seam check is distinct from — and ordered before — the 4a whole-goal verification.
    assert out.index("语义边界对账") < out.index("完工核验")


def test_format_for_ceo_surfaces_team_notes_for_reconciliation():
    # 合·对账 (docs/03-AI核心/编排器与CEO主Agent.md §收尾即验收「便签墙本身又是对账的现成输入」): the batch's
    # outstanding ACTIVE notes (decisions / claims workers broadcast while working) are folded into
    # the synthesis input as a checklist, and the 4b reconciliation step points the CEO at them.
    t = tool(Provider([]))
    wall = NoteWall()
    wall.post(run_id="w1", agent_id="a1", role="后端", kind=NOTE_KIND_DECISION, text="接口 /login")
    wall.post(run_id="w2", agent_id="a2", role="前端", kind=NOTE_KIND_CLAIM, text="登录页我来写")
    t._note_wall = wall
    plan = RunPlan(
        nodes=[
            RunSpec(run_id="w1", task="建登录接口", role="后端"),
            RunSpec(run_id="w2", task="建登录页面", role="前端", depends_on=["w1"]),
        ]
    )
    results = {
        "w1": RunState(phase=RunPhase.COMPLETED, content="接口已完成"),
        "w2": RunState(phase=RunPhase.COMPLETED, content="页面已完成"),
    }
    out = t._format_for_ceo(plan, results)
    assert "队员过程中广播的【当前有效】" in out  # the synthesis notes-block header
    assert "接口 /login" in out and "登录页我来写" in out
    assert "上方若有【团队便签】一并对照" in out
    # the checklist precedes the per-worker products (read it before reconciling the bodies).
    assert out.index("队员过程中广播的【当前有效】") < out.index("run_id: `w1`")


def test_format_for_ceo_omits_team_notes_when_no_wall_or_empty():
    # A CEO that never delegated (no wall) or a wall nobody posted to ⇒ no notes block (零行为变化).
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="查资料", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="一段综述")}
    assert "队员过程中广播的【当前有效】" not in t._format_for_ceo(plan, results)  # default: no wall
    t._note_wall = NoteWall()  # on a team but nothing posted / all retracted
    assert "队员过程中广播的【当前有效】" not in t._format_for_ceo(plan, results)


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
            escalations=[
                {"question": "目标受众是谁?", "assumption": "暂按大众", "blocking": False}
            ],
        ),
        "w2": RunState(
            phase=RunPhase.COMPLETED,
            content="后端骨架",
            escalations=[
                {"question": "用 Postgres 还是 MySQL?", "assumption": "暂用 PG", "blocking": True}
            ],
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
        "w1": RunState(phase=RunPhase.COMPLETED, content=long_body, files_touched=["report.md"])
    }
    out = t._format_for_ceo(plan, results)
    assert "`report.md`" in out
    # HEAD+TAIL digest (not head-only): the product is still digested — its 5000-char
    # middle is elided, so it is NOT the full content — but BOTH ends now survive, so the
    # 收尾 / 关键取舍 at the tail reach the CEO instead of being silently dropped.
    assert "开头摘要" in out
    assert "结尾独特标记XYZ" in out
    assert "中间省略" in out
    assert ("废" * 5_000) not in out
    assert len(out) < len(long_body)


def test_format_for_ceo_bounds_wide_fanout_keeping_all_workers_and_closing():
    t = tool(Provider([]))
    nodes = [RunSpec(run_id=f"w{i}", task="分析", role=f"分析{i}") for i in range(8)]
    plan = RunPlan(nodes=nodes)
    results = {
        f"w{i}": RunState(phase=RunPhase.COMPLETED, content=f"头{i}" + ("数" * 8_000) + f"尾{i}")
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


def test_format_for_ceo_surfaces_next_steps_advisory_and_leads_with_summary():
    # 完工交接简报: the per-worker synthesis body LEADS with the author's 结论 (from the structured
    # debrief), and each worker's 建议下一步 is gathered into one advisory section.
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="调研", role="研究员")])
    results = {
        "w1": RunState(
            phase=RunPhase.COMPLETED,
            content="一段研究综述正文。",
            debrief={"summary": "结论是甲", "next_steps": "补做竞品对比"},
        )
    }
    out = t._format_for_ceo(plan, results)
    assert "队员建议的下一步" in out
    assert "补做竞品对比" in out
    assert "交接结论：结论是甲" in out  # per-worker body leads with the author summary
    assert "一段研究综述正文。" in out  # the deliverable body follows the lead


def test_format_for_ceo_no_next_steps_section_when_none():
    t = tool(Provider([]))
    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="调研", role="研究员")])
    results = {"w1": RunState(phase=RunPhase.COMPLETED, content="只有正文，没有交接简报小节。")}
    out = t._format_for_ceo(plan, results)
    # The advisory SECTION (its unique intro) is absent; the closing instruction's conditional
    # mention of 『队员建议的下一步』 may still appear and is fine.
    assert "顺带提的后续方向" not in out


def test_direct_result_answers_with_deliverable_and_footers_next_steps():
    # finalize=true (single worker → user): the answer IS the clean deliverable; a 建议下一步 from
    # the structured debrief is re-attached as a readable footer (no CEO synthesis pass to relay it).
    from agentcore.tools.builtin.delegate.ceo_format import direct_result

    t = tool(Provider([]))
    state = RunState(
        phase=RunPhase.COMPLETED,
        content="最终交付正文。",
        debrief={"summary": "完成", "next_steps": "可考虑加单测"},
    )
    res = direct_result(t, state)
    assert res.final_text.startswith("最终交付正文。")
    assert "**建议下一步**：可考虑加单测" in res.final_text  # next-step relayed as a footer


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
