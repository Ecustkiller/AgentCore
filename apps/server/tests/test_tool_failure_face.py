"""Central tool-failure user face (``tool_use_end.failure``)."""

from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import ToolError, ValidationError
from agentcore.runtime.engine.tool_failure_face import (
    DEFAULT_TOOL_FAILURE_MESSAGE,
    tool_failure_fields,
    tool_failure_from_result,
)
from agentcore.runtime.events import tool_use_end
from agentcore.tools.protocol import ToolResult


def test_tool_failure_fields_passes_agentcore_product_copy():
    face = tool_failure_fields(exc=ToolError("沙箱启动失败，请稍后重试"))
    assert face == {
        "message": "沙箱启动失败，请稍后重试",
        "code": ErrorCode.TOOL_ERROR,
    }


def test_tool_failure_fields_collapses_unclassified_exc_to_curated():
    face = tool_failure_fields(exc=RuntimeError("ConnectError: 127.0.0.1:8888 boom"))
    assert face["code"] == ErrorCode.TOOL_ERROR
    assert face["message"] == DEFAULT_TOOL_FAILURE_MESSAGE
    assert "127.0.0.1" not in face["message"]
    assert "ConnectError" not in face["message"]


def test_tool_failure_fields_passes_authored_product_message():
    face = tool_failure_fields(
        code="args_parse_failed",
        product_message="长文保存失败，改成分段写入继续。",
    )
    assert face == {
        "message": "长文保存失败，改成分段写入继续。",
        "code": "args_parse_failed",
    }


def test_tool_failure_fields_curates_by_stable_code():
    face = tool_failure_fields(code="retrieval_budget_exhausted")
    assert face == {
        "message": "本回合检索次数已用尽。",
        "code": "retrieval_budget_exhausted",
    }


def test_tool_failure_from_result_never_lifts_error_output():
    result = ToolResult(
        tool_call_id="t1",
        success=False,
        output="stderr:\nExecEnvProbeFailed: no docker",
        error="ConnectError: host:8080 refused",
    )
    face = tool_failure_from_result(result)
    assert face["message"] == DEFAULT_TOOL_FAILURE_MESSAGE
    assert face["code"] == ErrorCode.TOOL_ERROR
    assert "ExecEnvProbeFailed" not in face["message"]
    assert "host:8080" not in face["message"]


def test_tool_failure_from_result_honors_optional_user_fields():
    result = ToolResult(
        tool_call_id="t1",
        success=False,
        output="model detail with tokens",
        error="str(exc)",
        failure_message="浏览器宿主暂时不可用，请稍后重试。",
        failure_code="host_unavailable",
    )
    assert tool_failure_from_result(result) == {
        "message": "浏览器宿主暂时不可用，请稍后重试。",
        "code": "host_unavailable",
    }


def test_tool_failure_from_result_uses_metadata_code_curated():
    result = ToolResult(
        tool_call_id="t1",
        success=False,
        output="Timeout: no output for 60s",
        error="idle",
        metadata={"code": "exec_timeout"},
    )
    assert tool_failure_from_result(result) == {
        "message": "执行超时，请缩小范围后重试。",
        "code": "exec_timeout",
    }


def test_tool_failure_from_result_coded_gets_curated_uncoded_stays_generic():
    """Acceptance: authored stable code → specialty sentence; bare fail → default."""
    from agentcore.db.errors import DATABASE_UNAVAILABLE_CODE, DATABASE_UNAVAILABLE_MESSAGE
    from agentcore.tools.sandbox.exec_env import (
        EXEC_ENV_PROBE_FAIL_CODE,
        EXEC_ENV_PROBE_FAIL_USER_MESSAGE,
    )

    coded = ToolResult(
        tool_call_id="t1",
        success=False,
        output=f"列出项目失败。{DATABASE_UNAVAILABLE_MESSAGE}",
        error=DATABASE_UNAVAILABLE_CODE,
        failure_code=DATABASE_UNAVAILABLE_CODE,
    )
    assert tool_failure_from_result(coded) == {
        "message": DATABASE_UNAVAILABLE_MESSAGE,
        "code": DATABASE_UNAVAILABLE_CODE,
    }

    probe = ToolResult(
        tool_call_id="t2",
        success=False,
        output="stderr:\nExecEnvProbeFailed: …",
        error="exit 1",
        metadata={"code": EXEC_ENV_PROBE_FAIL_CODE},
    )
    assert tool_failure_from_result(probe) == {
        "message": EXEC_ENV_PROBE_FAIL_USER_MESSAGE,
        "code": EXEC_ENV_PROBE_FAIL_CODE,
    }

    uncoded = ToolResult(
        tool_call_id="t3",
        success=False,
        output="weird internal token XYZ",
        error="RuntimeError: boom",
    )
    face = tool_failure_from_result(uncoded)
    assert face == {
        "message": DEFAULT_TOOL_FAILURE_MESSAGE,
        "code": ErrorCode.TOOL_ERROR,
    }
    assert "XYZ" not in face["message"]
    assert "RuntimeError" not in face["message"]


def test_curated_copy_stays_synced_with_tool_sources():
    """Curated table must stay byte-equal to tool/db product constants (no import cycle)."""
    from agentcore.db.errors import DATABASE_UNAVAILABLE_MESSAGE
    from agentcore.runtime.engine.tool_failure_face import _CURATED_BY_CODE
    from agentcore.tools.sandbox.exec_env import EXEC_ENV_PROBE_FAIL_USER_MESSAGE

    assert _CURATED_BY_CODE["database_unavailable"] == DATABASE_UNAVAILABLE_MESSAGE
    assert _CURATED_BY_CODE[ErrorCode.DATABASE_UNAVAILABLE] == DATABASE_UNAVAILABLE_MESSAGE
    assert _CURATED_BY_CODE["exec_env_probe_failed"] == EXEC_ENV_PROBE_FAIL_USER_MESSAGE
    assert _CURATED_BY_CODE["searxng_unreachable"] == "本地搜索服务不可用，请稍后重试"
    assert _CURATED_BY_CODE["workspace_channel_dead"] == _CURATED_BY_CODE[ErrorCode.STREAM_ERROR]


def test_tool_use_end_omits_failure_on_success():
    ev = tool_use_end(
        "tc1",
        "web_search",
        success=True,
        output="ok",
        failure={"message": "should not appear", "code": "TOOL_ERROR"},
    )
    assert "failure" not in ev.payload
    assert ev.payload["status"] == "success"


def test_tool_use_end_attaches_failure_on_error():
    ev = tool_use_end(
        "tc1",
        "web_search",
        success=False,
        output="搜索失败：ConnectError: host:8080",
        failure=tool_failure_fields(code=ErrorCode.TOOL_ERROR),
    )
    assert ev.payload["status"] == "error"
    assert ev.payload["result"] == "搜索失败：ConnectError: host:8080"
    assert ev.payload["failure"] == {
        "message": DEFAULT_TOOL_FAILURE_MESSAGE,
        "code": "TOOL_ERROR",
    }


def test_validation_error_exc_passes_through():
    face = tool_failure_fields(exc=ValidationError("参数缺少 query"))
    assert face == {"message": "参数缺少 query", "code": ErrorCode.VALIDATION_ERROR}
