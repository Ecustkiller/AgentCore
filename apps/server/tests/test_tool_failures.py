"""Tool-failure aggregation + synthesis facts (honest soft-landing)."""

from agentcore.runtime.loop_controller import LoopController, ToolAttempt
from agentcore.runtime.tool_failures import (
    ToolFailureFact,
    format_team_tool_failures_block,
    format_tool_failures_section,
    outstanding_facts,
)


def _fail(name: str, err: str = "boom", fp: str = "a") -> ToolAttempt:
    return ToolAttempt(
        fingerprint=fp, tool_name=name, success=False, error_summary=err
    )


def _ok(name: str, fp: str = "b") -> ToolAttempt:
    return ToolAttempt(fingerprint=fp, tool_name=name, success=True)


def test_aggregate_outstanding_until_same_tool_succeeds():
    c = LoopController()
    c.record([_fail("code_execute", "crash 1", "1")])
    c.record([_fail("code_execute", "crash 2", "2")])
    facts = c.tool_failure_facts()
    assert len(facts) == 1
    assert facts[0].tool_name == "code_execute"
    assert facts[0].failure_count == 2
    assert facts[0].last_error == "crash 2"
    assert facts[0].succeeded_after is False
    assert facts[0].outstanding is True
    assert len(c.outstanding_tool_failures()) == 1

    c.record([_ok("code_execute", "3")])
    facts2 = c.tool_failure_facts()
    assert facts2[0].failure_count == 2
    assert facts2[0].succeeded_after is True
    assert facts2[0].outstanding is False
    assert c.outstanding_tool_failures() == []


def test_aggregate_ignores_policy_failures_like_circuit_breaker():
    c = LoopController()
    c.record(
        [
            ToolAttempt(
                "a", "write", success=False, policy_failure=True, error_summary="denied"
            )
        ]
    )
    assert c.tool_failure_facts() == []
    assert c.tool_failure_count("write") == 0


def test_fail_after_success_reopens_outstanding():
    c = LoopController()
    c.record([_fail("t", "e1"), _ok("t"), _fail("t", "e2", fp="z")])
    facts = c.outstanding_tool_failures()
    assert len(facts) == 1
    assert facts[0].failure_count == 2
    assert facts[0].last_error == "e2"
    assert facts[0].succeeded_after is False


def test_format_section_legend():
    facts = [
        ToolFailureFact(
            tool_name="code_execute",
            failure_count=2,
            last_error="Sandbox crash",
            succeeded_after=False,
        )
    ]
    section = format_tool_failures_section(facts)
    assert "### tool_failures" in section
    assert "code_execute" in section
    assert "failures=2" in section
    assert "succeeded_after=false" in section
    assert "Sandbox crash" in section
    assert outstanding_facts(facts)[0].outstanding is True


def test_team_block_lists_facts():
    products = [
        {
            "role": "工程师",
            "run_id": "w1",
            "tool_failures": [
                {
                    "tool_name": "code_execute",
                    "failure_count": 2,
                    "last_error": "crash",
                    "succeeded_after": False,
                }
            ],
        }
    ]
    block = format_team_tool_failures_block(products)
    assert "### tool_failures" in block
    assert "code_execute" in block
    assert "succeeded_after=false" in block


def test_team_block_includes_compensated():
    products = [
        {
            "role": "工程师",
            "run_id": "w1",
            "tool_failures": [
                {
                    "tool_name": "code_execute",
                    "failure_count": 1,
                    "last_error": "tmp",
                    "succeeded_after": True,
                }
            ],
        }
    ]
    block = format_team_tool_failures_block(products)
    assert "### tool_failures" in block
    assert "succeeded_after=true" in block
