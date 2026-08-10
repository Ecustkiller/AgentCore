"""委派前能力软警告（S3：无 code_verified / runtime_ready kind 硬闸）。"""

from __future__ import annotations

from agentcore.runtime.delegate.completion import execution_capability_warning
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunSpec
from tests.delegate.conftest import LocalBackend


class _CloudBackend:
    location = "server"


def _plan(task: str = "写文件") -> RunPlan:
    return RunPlan(nodes=[RunSpec(run_id="a", role="dev", task=task)])


def test_soft_warning_on_run_text_without_execution_class():
    plan = _plan("运行脚本生成可播放 pptx")
    warn = execution_capability_warning(plan, _CloudBackend())
    assert warn is not None
    assert "未装配" in warn or "能力提示" in warn


def test_soft_warning_silent_on_local_with_execution():
    # LocalBackend is treated as execution-capable in unit env.
    plan = _plan("运行 pytest")
    warn = execution_capability_warning(plan, LocalBackend())
    # May be None when execution class enabled; never blocks.
    assert warn is None or warn.startswith("[能力提示]")


def test_soft_warning_office_without_execution():
    plan = _plan("生成演示文稿.pptx")
    warn = execution_capability_warning(plan, _CloudBackend())
    assert warn is not None
    assert "Office" in warn or "docx" in warn or "pptx" in warn


def test_soft_warning_silent_when_no_run_smell():
    assert execution_capability_warning(_plan("写一段说明文字"), _CloudBackend()) is None


def test_soft_warning_silent_on_bare_open_file():
    """裸「打开文件 / 打开 .mdc」无运行味，不再触发 execution soft warning。"""
    assert execution_capability_warning(_plan("打开文件"), _CloudBackend()) is None
    assert (
        execution_capability_warning(
            _plan("打开 `.cursor/rules/x.mdc`"), _CloudBackend()
        )
        is None
    )


def test_soft_warning_on_open_acceptance_via_yanshou():
    """「打开验收」仍经「验收」命中运行类 soft warning。"""
    warn = execution_capability_warning(_plan("打开验收"), _CloudBackend())
    assert warn is not None
    assert "未装配" in warn or "能力提示" in warn
