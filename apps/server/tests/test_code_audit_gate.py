"""code_audit 结构闸（L2b / L3）单元测试。"""

from agentcore.runtime.runs.code_audit_gate import (
    code_audit_json_failures,
    validate_code_audit_payload,
)
from agentcore.runtime.runs.contract import check_contract
from agentcore.runtime.runs.types import Deliverable


def _ok_finding(**overrides):
    base = {
        "id": "S1",
        "severity": "低",
        "verification": "全文精读",
        "verdict": "属实",
        "evidence": "foo.py:10",
        "summary": "小问题",
    }
    base.update(overrides)
    return base


def test_validate_rejects_unread_as_medium():
    fails = validate_code_audit_payload(
        {
            "schema_version": 1,
            "findings": [
                _ok_finding(
                    severity="中",
                    verification="静态推断·未读全",
                    verdict="属实",
                )
            ],
        }
    )
    assert any("不得标中/高" in f for f in fails)


def test_validate_high_requires_trigger_and_reachability():
    fails = validate_code_audit_payload(
        {
            "findings": [
                _ok_finding(severity="高", category="安全"),
            ]
        }
    )
    assert any("trigger_path" in f for f in fails)
    assert any("reachability" in f for f in fails)


def test_validate_l3_rejects_timeout_as_medium_defect():
    fails = validate_code_audit_payload(
        {
            "findings": [
                _ok_finding(
                    severity="中",
                    summary="desktop typecheck 超时",
                    evidence="tsc --noEmit Timeout: execution exceeded 300s",
                )
            ]
        }
    )
    assert any("超时" in f and "中+" in f for f in fails)


def test_validate_accepts_clean_low_finding():
    assert (
        validate_code_audit_payload({"findings": [_ok_finding()]}) == []
    )


def test_validate_accepts_evidence_as_string_list():
    """Models often emit evidence as string[]; gate normalizes (dogfood d3b6f1b8)."""
    assert (
        validate_code_audit_payload(
            {
                "findings": [
                    _ok_finding(
                        evidence=[
                            "apps/desktop/src/main/sidecar-event-buffer.ts:132-143",
                            "apps/desktop/src/main/sidecar/manager.ts:552-569",
                        ]
                    ),
                    _ok_finding(
                        id="R2",
                        summary="流式投影",
                        evidence=[
                            "apps/desktop/src/renderer/services/sse/dispatch.ts:47-66",
                        ],
                    ),
                ]
            }
        )
        == []
    )


def test_validate_accepts_evidence_path_line_object():
    assert (
        validate_code_audit_payload(
            {"findings": [_ok_finding(evidence={"path": "foo.py", "line": 10})]}
        )
        == []
    )


def test_validate_rejects_empty_evidence_shapes():
    fails = validate_code_audit_payload(
        {
            "findings": [
                _ok_finding(evidence=[]),
                _ok_finding(evidence=""),
                _ok_finding(evidence={"path": ""}),
            ]
        }
    )
    assert sum(1 for f in fails if "evidence 为空或无法归一" in f) >= 3


def test_normalize_audit_evidence_joins_list():
    from agentcore.runtime.runs.code_audit_gate import normalize_audit_evidence

    assert normalize_audit_evidence(["a.ts:1", "b.ts:2"]) == "a.ts:1；b.ts:2"
    assert normalize_audit_evidence([]) == ""
    assert normalize_audit_evidence(None) == ""


def test_validate_accepts_english_severity_and_verdict():
    assert (
        validate_code_audit_payload(
            {
                "findings": [
                    _ok_finding(severity="low", verdict="confirmed"),
                    _ok_finding(
                        severity="MEDIUM",
                        verdict="false_positive",
                        summary="误报样例",
                    ),
                    _ok_finding(
                        severity="info",
                        verdict="pending",
                        summary="观察样例",
                    ),
                    _ok_finding(
                        severity="critical",
                        verdict="partially confirmed",
                        trigger_path="POST /x → handler",
                        reachability="用户可控输入经校验前直达",
                        summary="高危样例",
                    ),
                ]
            }
        )
        == []
    )


def test_validate_accepts_p_level_severity():
    """P0–P3 → 高|中|低|观察·工程（钉死映射；落盘权威仍为中文闭集）。"""
    from agentcore.runtime.runs.code_audit_gate import normalize_audit_severity

    assert normalize_audit_severity("P0") == "高"
    assert normalize_audit_severity("p1") == "中"
    assert normalize_audit_severity("P2") == "低"
    assert normalize_audit_severity("P3") == "观察·工程"
    assert (
        validate_code_audit_payload(
            {
                "findings": [
                    _ok_finding(
                        severity="P3",
                        summary="观察·工程样例（P3）",
                    ),
                    _ok_finding(
                        severity="P2",
                        summary="低危样例（P2）",
                    ),
                    _ok_finding(
                        severity="P1",
                        summary="中危样例（P1）",
                    ),
                    _ok_finding(
                        severity="P0",
                        trigger_path="POST /x → handler",
                        reachability="用户可控输入经校验前直达",
                        summary="高危样例（P0）",
                    ),
                ]
            }
        )
        == []
    )


def test_validate_rejects_compound_severity_and_verdict():
    fails = validate_code_audit_payload(
        {
            "findings": [
                _ok_finding(verdict="属实（不进 N）"),
                _ok_finding(severity="低（观察）", verdict="误报（已撤销）"),
            ]
        }
    )
    assert any("verdict 无效" in f for f in fails)
    assert any("severity 无效" in f for f in fails)


def test_validate_english_pending_still_blocks_medium():
    fails = validate_code_audit_payload(
        {
            "findings": [
                _ok_finding(severity="medium", verdict="pending"),
            ]
        }
    )
    assert any("不得标中/高" in f for f in fails)


def test_check_contract_code_audit_gate_wires_through():
    md = "## 〇、人审速览\n## 一、属实缺陷\n验证方式\n定案\n## 二、已撤销\n## 三、观察与工程债\n"
    json_path = "AgentCore/文档/reviews/x.audit.json"
    md_path = "AgentCore/文档/reviews/x.md"
    bad_json = '{"findings":[{"severity":"中","verification":"静态推断·未读全","verdict":"属实","evidence":"a:1","summary":"x"}]}'
    d = Deliverable(
        form="files",
        artifacts=[md_path, json_path],
        required_sections=["〇、人审速览", "一、属实缺陷", "二、已撤销", "三、观察与工程债"],
        strict=True,
        code_audit_gate=True,
    )
    verdict = check_contract(
        "简报",
        d,
        files_written=2,
        workspace_paths=[md_path, json_path],
        artifact_contents={md_path: md, json_path: bad_json},
    )
    assert not verdict.ok
    assert any("不得标中/高" in f for f in verdict.failures)
    from agentcore.runtime.runs.contract import contract_run_failure_kind

    assert contract_run_failure_kind(verdict) == "format"
    assert all(f.startswith("结构闸：") for f in verdict.failures)


def test_check_contract_accepts_p3_audit_json():
    md = "## 〇、人审速览\n## 一、属实缺陷\n验证方式\n定案\n## 二、已撤销\n## 三、观察与工程债\n"
    json_path = "AgentCore/文档/reviews/x.audit.json"
    md_path = "AgentCore/文档/reviews/x.md"
    ok_json = (
        '{"findings":[{"severity":"P3","verification":"全文精读","verdict":"属实",'
        '"evidence":"a:1","summary":"超时观察"}]}'
    )
    d = Deliverable(
        form="files",
        artifacts=[md_path, json_path],
        required_sections=["〇、人审速览", "一、属实缺陷", "二、已撤销", "三、观察与工程债"],
        strict=True,
        code_audit_gate=True,
    )
    verdict = check_contract(
        "简报",
        d,
        files_written=2,
        workspace_paths=[md_path, json_path],
        artifact_contents={md_path: md, json_path: ok_json},
    )
    assert verdict.ok
    assert verdict.failures == []


def test_code_audit_json_failures_missing_file():
    fails = code_audit_json_failures(
        artifacts=["AgentCore/文档/reviews/x.audit.json"],
        workspace_paths=[],
        artifact_contents={},
    )
    assert any("缺少" in f for f in fails)
    assert all(f.startswith("结构闸：") for f in fails)
    from agentcore.runtime.runs.code_audit_gate import (
        is_code_audit_landing_absence_failure,
    )

    assert all(is_code_audit_landing_absence_failure(f) for f in fails)


def test_check_contract_code_audit_skips_absence_hard_fail_when_channel_dead():
    """写盘通道 dead：缺 audit JSON 不结构硬拒，归因进 soft tip。"""
    from agentcore.runtime.runs.contract import check_contract
    from agentcore.runtime.runs.types import Deliverable

    json_path = "AgentCore/文档/reviews/x.audit.json"
    md_path = "AgentCore/文档/reviews/x.md"
    d = Deliverable(
        form="files",
        artifacts=[md_path, json_path],
        required_sections=[],
        strict=True,
        code_audit_gate=True,
    )
    verdict = check_contract(
        "简报已写但通道挂了",
        d,
        files_written=0,
        workspace_paths=[],
        artifact_contents={},
        landing_failure_kind="channel_dead",
    )
    assert verdict.ok
    assert not any("缺少 audit JSON" in f for f in verdict.failures)
    assert any("写盘通道不可用" in w for w in verdict.warnings)
    assert not any("粘在回复正文" in w for w in verdict.warnings)


def test_check_contract_code_audit_still_validates_loaded_json_when_channel_dead():
    """通道 dead 但 JSON 已读到：字段语义仍硬拒。"""
    from agentcore.runtime.runs.contract import check_contract, contract_run_failure_kind
    from agentcore.runtime.runs.types import Deliverable

    md = "## 〇、人审速览\n## 一、属实缺陷\n验证方式\n定案\n## 二、已撤销\n## 三、观察与工程债\n"
    json_path = "AgentCore/文档/reviews/x.audit.json"
    md_path = "AgentCore/文档/reviews/x.md"
    bad_json = (
        '{"findings":[{"severity":"中","verification":"静态推断·未读全",'
        '"verdict":"属实","evidence":"a:1","summary":"x"}]}'
    )
    d = Deliverable(
        form="files",
        artifacts=[md_path, json_path],
        required_sections=["〇、人审速览", "一、属实缺陷", "二、已撤销", "三、观察与工程债"],
        strict=True,
        code_audit_gate=True,
    )
    verdict = check_contract(
        "简报",
        d,
        files_written=2,
        workspace_paths=[md_path, json_path],
        artifact_contents={md_path: md, json_path: bad_json},
        landing_failure_kind="channel_dead",
    )
    assert not verdict.ok
    assert any("不得标中/高" in f for f in verdict.failures)
    assert contract_run_failure_kind(verdict) == "format"
