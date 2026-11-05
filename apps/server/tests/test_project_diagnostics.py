"""Project-native diagnostics adapter."""

import json

from agentcore.tools.builtin.project_diagnostics import (
    ProjectDiagnosticsTool,
    _parse_diagnostics,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.protocol import ExecutionResult


class _ExecBackend:
    location = "local"

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.requests = []

    async def execute(self, request):
        self.requests.append(request)
        return ExecutionResult(
            success=True,
            stdout=json.dumps(self.payload),
            stderr="",
            exit_code=0,
            duration_ms=1,
        )


def _ctx(backend: _ExecBackend) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="r",
        agent_id="a",
        backend=backend,  # type: ignore[arg-type]
        user_id="u",
    )


def test_parse_typescript_diagnostics():
    diagnostics = _parse_diagnostics(
        "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        language="typescript",
    )

    assert len(diagnostics) == 1
    assert diagnostics[0].path == "src/a.ts"
    assert diagnostics[0].line == 3
    assert diagnostics[0].col == 7
    assert diagnostics[0].code == "TS2322"


def test_parse_mypy_diagnostics():
    diagnostics = _parse_diagnostics(
        'src/a.py:4:9: error: Incompatible types in assignment '
        '(expression has type "str", variable has type "int")  [assignment]\n',
        language="python",
    )

    assert len(diagnostics) == 1
    assert diagnostics[0].line == 4
    assert diagnostics[0].col == 9
    assert diagnostics[0].code == "assignment"


async def test_project_diagnostics_returns_structured_errors():
    backend = _ExecBackend(
        {
            "kind": "completed",
            "language": "typescript",
            "command": ["node", "tsc"],
            "exit_code": 2,
            "output": "src/a.ts(1,2): error TS1001: bad\n",
        }
    )

    result = await ProjectDiagnosticsTool().execute(
        {"language": "typescript"},
        _ctx(backend),
    )

    assert result.success is True
    assert "src/a.ts:1:2: error: bad [TS1001]" in result.output
    assert result.metadata["diagnostics"] == 1
    assert backend.requests[0].network_mode == "none"


async def test_project_diagnostics_reports_unavailable_provider():
    result = await ProjectDiagnosticsTool().execute(
        {"language": "python"},
        _ctx(
            _ExecBackend(
                {
                    "kind": "unavailable",
                    "language": "python",
                    "reason": "当前运行环境未安装 mypy",
                }
            )
        ),
    )

    assert result.success is False
    assert result.contract_failure is True
    assert "mypy" in (result.error or "")


async def test_project_diagnostics_rejects_unsafe_path():
    result = await ProjectDiagnosticsTool().execute(
        {"language": "python", "path": "../outside"},
        _ctx(_ExecBackend({"kind": "unavailable"})),
    )

    assert result.success is False
    assert result.contract_failure is True
