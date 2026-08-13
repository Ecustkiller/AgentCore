"""Exec-env probe: once-per-language gate + honest failure attribution.

The probe already holds the facts that name its own failure (exit code, duration,
stderr). These tests pin that verdict travelling all the way out — wire code,
model-facing text, user sentence — instead of five different causes collapsing
into one guess about the desktop / security software.

They also pin its *scope*: the probe runs the language the request asked for, so
a machine without python still runs JavaScript, and only the language that was
actually probed gets taken out.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agentcore.tools.sandbox.exec_env import (
    EXEC_ENV_NO_INTERPRETER_CODE,
    EXEC_ENV_PROBE_FAIL_CODE,
    EXEC_ENV_PROBE_FAIL_CODES,
    EXEC_ENV_PROBE_FAIL_MARKER,
    EXEC_ENV_PROBE_TIMEOUT_CODE,
    EXEC_ENV_SPAWN_DENIED_CODE,
    classify_probe_failure,
    exec_env_probe_failure_code,
    exec_env_probe_failure_language,
    is_exec_env_probe_failure,
    looks_like_exec_timeout_text,
    probe_failure_result,
    probe_failure_retire_steer,
    probe_failure_retire_tools,
)
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult
from agentcore.workspace.channel import WorkspaceOp
from agentcore.workspace.limits import (
    EXEC_ENV_DEAD_BODY_MARKER,
    EXEC_ENV_DEAD_USER_VISIBLE,
    EXEC_ENV_DEAD_USER_VISIBLE_BY_CODE,
    exec_env_dead_user_visible,
)
from agentcore.workspace.local import LocalWorkspace
from agentcore.workspace.server import ServerWorkspace


class _FakeSandbox:
    """Sandbox that reports health without naming a reason (gVisor-shaped)."""

    def __init__(self, *, health_ok: bool = True) -> None:
        self.health_ok = health_ok
        self.health_calls = 0
        self.execute_calls = 0

    async def health_check(self) -> bool:
        self.health_calls += 1
        return self.health_ok

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        self.execute_calls += 1
        return ExecutionResult(
            success=True,
            stdout="hi",
            stderr="",
            exit_code=0,
            duration_ms=1,
        )


class _ClassifyingSandbox(_FakeSandbox):
    """Sandbox that classified its own health failure (SubprocessSandbox-shaped)."""

    def __init__(self, *, code: str, evidence: str) -> None:
        super().__init__(health_ok=False)
        self.last_health_failure = ("exit=127 duration_ms=8", "找不到命令 'python'")
        self.last_health_failure_code = code
        self.last_health_evidence = evidence


# Launcher each language is started with, shared by the host fakes below.
_LAUNCHERS = {"python": "python", "javascript": "node", "bash": "bash"}


def _missing_launcher_stderr(language: str) -> str:
    launcher = _LAUNCHERS[language]
    return (
        f"代码执行环境启动失败：找不到命令 '{launcher}'。"
        f" 请确认 PATH 上有 {launcher} 可执行文件。"
    )


class _HostSandbox(_FakeSandbox):
    """A host with only some interpreters on PATH (SubprocessSandbox-shaped)."""

    def __init__(self, *available: str) -> None:
        super().__init__(health_ok="python" in available)
        self._available = set(available)
        self.probed: list[str] = []
        self.last_health_failure: tuple[str, str | None] | None = None
        self.last_health_failure_code: str | None = None
        self.last_health_evidence: str | None = None

    async def probe_interpreter(self, language: str) -> bool:
        self.probed.append(language)
        self.last_health_failure = None
        self.last_health_failure_code = None
        self.last_health_evidence = None
        if language in self._available:
            return True
        detail = _missing_launcher_stderr(language)
        self.last_health_failure = ("exit=127 duration_ms=7", detail)
        self.last_health_failure_code = EXEC_ENV_NO_INTERPRETER_CODE
        self.last_health_evidence = f"exit=127 duration_ms=7 stderr={detail}"
        return False


class _FakeChannel:
    """Minimal desktop channel: replays canned EXECUTE envelopes."""

    conversation_id = "conv-exec-probe"

    def __init__(self, *envelopes: dict[str, object]) -> None:
        self._envelopes = list(envelopes)
        self.calls: list[dict[str, object]] = []

    async def request(
        self,
        op: WorkspaceOp,
        args: dict[str, object],
        *,
        timeout: float | None = None,
        root_id: str | None = None,
    ) -> dict[str, object]:
        self.calls.append({"op": op, "args": args})
        if self._envelopes:
            return self._envelopes.pop(0)
        return {"success": True, "stdout": "ok\n", "stderr": "", "exit_code": 0, "duration_ms": 4}


def _envelope(
    *, success: bool = False, stdout: str = "", stderr: str = "", exit_code: int, duration_ms: int
) -> dict[str, object]:
    return {
        "success": success,
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": exit_code,
        "duration_ms": duration_ms,
    }


class _HostChannel(_FakeChannel):
    """Desktop channel for a machine that only has some interpreters installed."""

    def __init__(self, *available: str) -> None:
        super().__init__()
        self._available = set(available)

    async def request(
        self,
        op: WorkspaceOp,
        args: dict[str, object],
        *,
        timeout: float | None = None,
        root_id: str | None = None,
    ) -> dict[str, object]:
        self.calls.append({"op": op, "args": args})
        language = str(args.get("language") or "")
        if language in self._available:
            return _envelope(success=True, stdout="ok\n", exit_code=0, duration_ms=5)
        return _envelope(
            stderr=_missing_launcher_stderr(language), exit_code=127, duration_ms=7
        )


# Desktop ``launcherMissingStderr`` / sandbox ``_launcher_missing_stderr`` wording.
_LAUNCHER_MISSING = (
    "代码执行环境启动失败：找不到命令 'python'。 请确认 PATH 上有 python 可执行文件。"
)


@pytest.mark.parametrize(
    ("exit_code", "duration_ms", "stderr", "expected"),
    [
        # exit=127: both backends' pre-spawn launcher reject.
        (127, 8, _LAUNCHER_MISSING, EXEC_ENV_NO_INTERPRETER_CODE),
        (127, 8, "", EXEC_ENV_NO_INTERPRETER_CODE),
        # Binary vanished between PATH lookup and spawn.
        (-1, 6, "Failed to start process: spawn python ENOENT", EXEC_ENV_NO_INTERPRETER_CODE),
        (
            None,
            None,
            "SandboxError: 代码执行环境启动失败：[Errno 2] No such file or directory: 'python'",
            EXEC_ENV_NO_INTERPRETER_CODE,
        ),
        # Timeout envelopes (desktop + sandbox write their own marker).
        (-1, 5031, "Timeout: forced stop after 5s (forced stop)", EXEC_ENV_PROBE_TIMEOUT_CODE),
        (-1, 60002, "Timeout: no output for 60s (execution stalled)", EXEC_ENV_PROBE_TIMEOUT_CODE),
        (
            None,
            None,
            "SandboxTimeoutError: Timeout: forced stop after 5s (forced stop)",
            EXEC_ENV_PROBE_TIMEOUT_CODE,
        ),
        # No marker, but the probe burned its whole budget without a clean exit.
        (-1, 5000, "", EXEC_ENV_PROBE_TIMEOUT_CODE),
        # Spawn refused by the OS — read as a denial even when the generic
        # 「代码执行环境启动失败」 startup wording is also present.
        (-1, 11, "Failed to start process: spawn python EACCES", EXEC_ENV_SPAWN_DENIED_CODE),
        (-1, 11, "Failed to start process: spawn python EPERM", EXEC_ENV_SPAWN_DENIED_CODE),
        (
            None,
            None,
            "SandboxError: 代码执行环境启动失败：[Errno 13] Permission denied: 'python'",
            EXEC_ENV_SPAWN_DENIED_CODE,
        ),
        (
            None,
            None,
            "SandboxError: 代码执行环境启动失败：[WinError 5] 拒绝访问。",
            EXEC_ENV_SPAWN_DENIED_CODE,
        ),
        # Unprovable: a launcher that ran and said nothing (Windows Store alias
        # stub), a plain non-zero exit, a slow clean exit. No guessing.
        (0, 120, "", EXEC_ENV_PROBE_FAIL_CODE),
        (0, 9000, "", EXEC_ENV_PROBE_FAIL_CODE),
        (
            9009,
            140,
            "Python was not found; run without arguments to install from the Microsoft Store",
            EXEC_ENV_PROBE_FAIL_CODE,
        ),
        (1, 30, "boom", EXEC_ENV_PROBE_FAIL_CODE),
    ],
)
def test_classify_probe_failure_only_names_provable_causes(
    exit_code: int | None, duration_ms: int | None, stderr: str, expected: str
):
    assert (
        classify_probe_failure(
            exit_code=exit_code, duration_ms=duration_ms, stderr=stderr
        )
        == expected
    )


def test_probe_failure_result_carries_reason_and_evidence():
    result = probe_failure_result(
        duration_ms=8,
        code=EXEC_ENV_NO_INTERPRETER_CODE,
        language="python",
        evidence=f"exit=127 duration_ms=8 stderr={_LAUNCHER_MISSING}",
    )
    assert result.success is False
    assert exec_env_probe_failure_code(result.stderr) == EXEC_ENV_NO_INTERPRETER_CODE
    # The model gets the cause and the facts behind it, not an opaque marker.
    assert "找不到 python 解释器" in result.stderr
    assert "exit=127" in result.stderr
    # …and the route that does still work, so it stops waiting for the sandbox.
    assert "terminal" in result.stderr
    assert "与权限或安全软件无关" in result.stderr


def test_probe_failure_stderr_stays_matchable_by_the_family_taxonomy():
    for code in EXEC_ENV_PROBE_FAIL_CODES:
        stderr = probe_failure_result(code=code).stderr
        assert EXEC_ENV_PROBE_FAIL_MARKER in stderr
        assert is_exec_env_probe_failure(stderr)
        assert looks_like_exec_timeout_text(stderr)
        assert exec_env_probe_failure_code(stderr) == code


def test_probe_retire_steer_names_the_cause_instead_of_claiming_a_timeout():
    from agentcore.runtime.loop_controller.types import EXEC_ENV_TIMEOUT_RETIRE_STEER

    steer = probe_failure_retire_steer(EXEC_ENV_NO_INTERPRETER_CODE, language="python")
    assert "PATH 上没有 python 解释器" in steer
    # The idle-hang steer stays put; a missing interpreter never「连续超时」.
    assert "连续超时" not in steer
    assert steer != EXEC_ENV_TIMEOUT_RETIRE_STEER
    assert "terminal" in steer
    assert "禁止再原样重试跑命令" in steer
    # Unknown / unclassified never invents a cause.
    assert "原因未判明" in probe_failure_retire_steer(EXEC_ENV_PROBE_FAIL_CODE)
    assert probe_failure_retire_steer("exec_env_haunted") == probe_failure_retire_steer(
        EXEC_ENV_PROBE_FAIL_CODE
    )


def test_probe_failure_code_falls_back_on_untagged_or_unknown_text():
    assert exec_env_probe_failure_code(None) == EXEC_ENV_PROBE_FAIL_CODE
    # Legacy (pre-taxonomy) journals and results carry no tag.
    assert (
        exec_env_probe_failure_code("ExecEnvProbeFailed: 本机执行环境自检未通过")
        == EXEC_ENV_PROBE_FAIL_CODE
    )
    # A tag we do not own never becomes a wire code.
    assert (
        exec_env_probe_failure_code("ExecEnvProbeFailed: [exec_env_haunted] …")
        == EXEC_ENV_PROBE_FAIL_CODE
    )
    assert probe_failure_result(code="exec_env_haunted").stderr.startswith(
        f"{EXEC_ENV_PROBE_FAIL_MARKER} [{EXEC_ENV_PROBE_FAIL_CODE}]"
    )


@pytest.mark.anyio
async def test_server_workspace_probe_pass_then_execute(tmp_path: Path):
    sandbox = _FakeSandbox(health_ok=True)
    ws = ServerWorkspace(root=tmp_path, sandbox=sandbox, location="local")
    result = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=5)
    )
    assert result.success is True
    assert sandbox.health_calls == 1
    assert sandbox.execute_calls == 1
    # Second call skips probe.
    await ws.execute(
        ExecutionRequest(code="print(2)", language="python", timeout_seconds=5)
    )
    assert sandbox.health_calls == 1
    assert sandbox.execute_calls == 2


@pytest.mark.anyio
async def test_server_workspace_probe_fail_blocks_execute(tmp_path: Path):
    sandbox = _FakeSandbox(health_ok=False)
    ws = ServerWorkspace(root=tmp_path, sandbox=sandbox, location="local")
    result = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=5)
    )
    assert result.success is False
    assert is_exec_env_probe_failure(result.stderr)
    assert EXEC_ENV_PROBE_FAIL_MARKER in result.stderr
    # A sandbox that named no reason must not acquire one.
    assert exec_env_probe_failure_code(result.stderr) == EXEC_ENV_PROBE_FAIL_CODE
    assert sandbox.execute_calls == 0
    # Sticky fail-fast without re-probing.
    again = await ws.execute(
        ExecutionRequest(code="print(2)", language="python", timeout_seconds=5)
    )
    assert again.success is False
    assert sandbox.health_calls == 1
    assert sandbox.execute_calls == 0


@pytest.mark.anyio
async def test_server_workspace_probe_fail_keeps_sandbox_verdict(tmp_path: Path):
    sandbox = _ClassifyingSandbox(
        code=EXEC_ENV_NO_INTERPRETER_CODE,
        evidence=f"exit=127 duration_ms=8 stderr={_LAUNCHER_MISSING}",
    )
    ws = ServerWorkspace(root=tmp_path, sandbox=sandbox, location="local")
    result = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=5)
    )
    assert exec_env_probe_failure_code(result.stderr) == EXEC_ENV_NO_INTERPRETER_CODE
    assert "exit=127" in result.stderr
    # The sticky repeat repeats the same cause, not a generic「跑不了」.
    again = await ws.execute(
        ExecutionRequest(code="print(2)", language="python", timeout_seconds=5)
    )
    assert exec_env_probe_failure_code(again.stderr) == EXEC_ENV_NO_INTERPRETER_CODE
    assert sandbox.health_calls == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("envelope", "expected"),
    [
        (
            _envelope(stderr=_LAUNCHER_MISSING, exit_code=127, duration_ms=8),
            EXEC_ENV_NO_INTERPRETER_CODE,
        ),
        (
            _envelope(
                stderr="Timeout: forced stop after 5s (forced stop)",
                exit_code=-1,
                duration_ms=5044,
            ),
            EXEC_ENV_PROBE_TIMEOUT_CODE,
        ),
        (
            _envelope(
                stderr="Failed to start process: spawn python EACCES",
                exit_code=-1,
                duration_ms=12,
            ),
            EXEC_ENV_SPAWN_DENIED_CODE,
        ),
        # Launcher ran, printed nothing (App Execution Alias stub) — unprovable.
        (
            _envelope(success=True, stdout="", exit_code=0, duration_ms=90),
            EXEC_ENV_PROBE_FAIL_CODE,
        ),
    ],
)
async def test_local_workspace_probe_classifies_desktop_envelope(
    envelope: dict[str, object], expected: str
):
    channel = _FakeChannel(envelope)
    ws = LocalWorkspace(channel)  # type: ignore[arg-type]
    result = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=30)
    )
    assert result.success is False
    assert exec_env_probe_failure_code(result.stderr) == expected
    # Only the probe reached the desktop; the real run never ran.
    assert len(channel.calls) == 1
    assert channel.calls[0]["args"]["code"] == "print('ok')"


@pytest.mark.anyio
async def test_local_workspace_sticky_fail_repeats_the_same_cause():
    channel = _FakeChannel(
        _envelope(
            stderr="Failed to start process: spawn python EACCES",
            exit_code=-1,
            duration_ms=12,
        )
    )
    ws = LocalWorkspace(channel)  # type: ignore[arg-type]
    first = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=30)
    )
    again = await ws.execute(
        ExecutionRequest(code="print(2)", language="python", timeout_seconds=30)
    )
    assert exec_env_probe_failure_code(first.stderr) == EXEC_ENV_SPAWN_DENIED_CODE
    assert exec_env_probe_failure_code(again.stderr) == EXEC_ENV_SPAWN_DENIED_CODE
    assert "EACCES" in again.stderr
    assert len(channel.calls) == 1


def test_probe_failure_text_names_the_language_it_actually_ran():
    js = probe_failure_result(
        code=EXEC_ENV_NO_INTERPRETER_CODE, language="javascript"
    ).stderr
    assert exec_env_probe_failure_language(js) == "javascript"
    assert "找不到 node 解释器" in js
    # The old text claimed「自检固定用 python，所以本次即便要跑 JavaScript 也一并被停用」.
    assert "python" not in js
    assert "不在本次自检范围内" in js

    py = probe_failure_result(code=EXEC_ENV_NO_INTERPRETER_CODE, language="python").stderr
    assert "找不到 python 解释器" in py
    assert "`test_run` 已停用" in py

    # A verdict that ran no interpreter (gVisor runtime smoke, legacy untagged
    # journals) names no language and still speaks for the whole family.
    wide = probe_failure_result(code=EXEC_ENV_PROBE_FAIL_CODE).stderr
    assert exec_env_probe_failure_language(wide) is None
    assert "code_execute / test_run 已停用" in wide


def test_probe_failure_retire_scope_follows_the_probed_language():
    from agentcore.runtime.loop_controller.types import EXEC_ENV_TIMEOUT_FAMILY

    # No language proven → unchanged blast radius (cloud / legacy).
    assert set(probe_failure_retire_tools(None)) == EXEC_ENV_TIMEOUT_FAMILY
    assert set(probe_failure_retire_tools("")) == EXEC_ENV_TIMEOUT_FAMILY
    # test_run wraps every check in a python script, so a dead python takes it…
    assert probe_failure_retire_tools("python") == ("test_run",)
    # …and nothing else: another language only takes itself out, so code_execute
    # stays listed for the languages whose interpreters are present.
    assert probe_failure_retire_tools("javascript") == ()
    assert probe_failure_retire_tools("bash") == ()


@pytest.mark.anyio
async def test_local_workspace_runs_javascript_on_a_host_without_python():
    """没有 python 但有 node：JavaScript 必须真跑，不被 python 自检打死。"""
    channel = _HostChannel("javascript", "bash")
    ws = LocalWorkspace(channel)  # type: ignore[arg-type]

    result = await ws.execute(
        ExecutionRequest(
            code="console.log(1)", language="javascript", timeout_seconds=30
        )
    )

    assert result.success is True
    # The probe ran the requested language, then the real code went through.
    assert [c["args"]["language"] for c in channel.calls] == [
        "javascript",
        "javascript",
    ]
    assert channel.calls[0]["args"]["code"] == "console.log('ok')"
    assert channel.calls[1]["args"]["code"] == "console.log(1)"


@pytest.mark.anyio
async def test_local_workspace_verdicts_never_leak_across_languages():
    channel = _HostChannel("javascript")
    ws = LocalWorkspace(channel)  # type: ignore[arg-type]

    dead = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=30)
    )
    assert dead.success is False
    assert exec_env_probe_failure_code(dead.stderr) == EXEC_ENV_NO_INTERPRETER_CODE
    assert exec_env_probe_failure_language(dead.stderr) == "python"

    # A dead python does not answer for node.
    alive = await ws.execute(
        ExecutionRequest(
            code="console.log(1)", language="javascript", timeout_seconds=30
        )
    )
    assert alive.success is True

    # python stays sticky-dead with the same cause, without re-probing.
    again = await ws.execute(
        ExecutionRequest(code="print(2)", language="python", timeout_seconds=30)
    )
    assert exec_env_probe_failure_code(again.stderr) == EXEC_ENV_NO_INTERPRETER_CODE
    assert [c["args"]["language"] for c in channel.calls] == [
        "python",
        "javascript",
        "javascript",
    ]


@pytest.mark.anyio
async def test_server_workspace_probes_the_requested_language(tmp_path: Path):
    """Sidecar SubprocessSandbox: one verdict per language, probed on demand."""
    sandbox = _HostSandbox("javascript", "bash")
    ws = ServerWorkspace(root=tmp_path, sandbox=sandbox, location="local")

    ok = await ws.execute(
        ExecutionRequest(
            code="console.log(1)", language="javascript", timeout_seconds=5
        )
    )
    dead = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=5)
    )

    assert ok.success is True
    assert dead.success is False
    assert exec_env_probe_failure_language(dead.stderr) == "python"
    assert sandbox.probed == ["javascript", "python"]
    # The language-free health check never runs on this path…
    assert sandbox.health_calls == 0
    # …and only the language that passed reached the sandbox for real.
    assert sandbox.execute_calls == 1


@pytest.mark.anyio
async def test_server_workspace_keeps_one_runtime_verdict_for_gvisor(tmp_path: Path):
    """云侧不变：runsc 冒烟与解释器语言无关，一次判定管住整个后端。"""
    sandbox = _FakeSandbox(health_ok=False)
    ws = ServerWorkspace(root=tmp_path, sandbox=sandbox, location="server")

    first = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=5)
    )
    second = await ws.execute(
        ExecutionRequest(
            code="console.log(1)", language="javascript", timeout_seconds=5
        )
    )

    assert first.success is False
    assert second.success is False
    assert sandbox.health_calls == 1
    assert sandbox.execute_calls == 0
    # No language in the verdict → the whole family stays the blast radius.
    assert exec_env_probe_failure_language(second.stderr) is None
    assert set(probe_failure_retire_tools(None)) == {"code_execute", "test_run"}


@pytest.mark.anyio
async def test_code_execute_retires_only_what_the_probe_proved():
    from agentcore.tools.builtin.code_execute import CodeExecuteTool
    from agentcore.tools.protocol import ToolContext

    class _ProbeFailBackend:
        def __init__(self, language: str) -> None:
            self._language = language

        async def execute(self, request: ExecutionRequest) -> ExecutionResult:
            return probe_failure_result(
                code=EXEC_ENV_NO_INTERPRETER_CODE, language=self._language
            )

    def _ctx(language: str) -> ToolContext:
        return ToolContext.create(
            execution_id="e",
            run_id="s",
            agent_id="a",
            backend=_ProbeFailBackend(language),  # type: ignore[arg-type]
            user_id="u",
        )

    js = await CodeExecuteTool().execute(
        {"code": "console.log(1)", "language": "javascript"}, _ctx("javascript")
    )
    assert js.success is False
    assert js.metadata is not None
    assert js.metadata.get("code") == EXEC_ENV_NO_INTERPRETER_CODE
    # Missing node says nothing about python or test_run: switch-the-language
    # reject, not a retire (the old code retired the whole family here).
    assert "retire_tools" not in js.metadata
    assert js.metadata.get("error_class") is None
    assert js.contract_failure is True

    py = await CodeExecuteTool().execute(
        {"code": "print(1)", "language": "python"}, _ctx("python")
    )
    assert py.metadata is not None
    assert py.metadata.get("retire_tools") == ["test_run"]
    assert py.metadata.get("error_class") == "permanent"
    assert "test_run" in (py.metadata.get("retire_message") or "")
    assert py.contract_failure is False


@pytest.mark.anyio
async def test_subprocess_sandbox_probes_the_language_it_is_asked_about(
    monkeypatch: pytest.MonkeyPatch,
):
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox

    sandbox = SubprocessSandbox()
    seen: list[ExecutionRequest] = []

    async def only_node(request: ExecutionRequest) -> ExecutionResult:
        seen.append(request)
        if request.language == "javascript":
            return ExecutionResult(
                success=True, stdout="ok\n", stderr="", exit_code=0, duration_ms=6
            )
        return ExecutionResult(
            success=False,
            stdout="",
            stderr=_LAUNCHER_MISSING,
            exit_code=127,
            duration_ms=0,
        )

    monkeypatch.setattr(sandbox, "execute", only_node)
    assert await sandbox.probe_interpreter("javascript") is True
    assert sandbox.last_health_failure_code is None
    # The protocol-level health check stays the python question (cloud boot probe).
    assert await sandbox.health_check() is False
    assert sandbox.last_health_failure_code == EXEC_ENV_NO_INTERPRETER_CODE
    assert [r.code for r in seen] == ["console.log('ok')", "print('ok')"]


@pytest.mark.anyio
async def test_subprocess_sandbox_health_check_classifies_launcher_and_denial(
    monkeypatch: pytest.MonkeyPatch,
):
    from agentcore.core.errors import SandboxError
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox

    sandbox = SubprocessSandbox()

    async def missing_launcher(request: ExecutionRequest) -> ExecutionResult:
        return ExecutionResult(
            success=False,
            stdout="",
            stderr=_LAUNCHER_MISSING,
            exit_code=127,
            duration_ms=0,
        )

    monkeypatch.setattr(sandbox, "execute", missing_launcher)
    assert await sandbox.health_check() is False
    assert sandbox.last_health_failure_code == EXEC_ENV_NO_INTERPRETER_CODE
    assert "exit=127" in (sandbox.last_health_evidence or "")

    async def denied(request: ExecutionRequest) -> ExecutionResult:
        raise SandboxError("代码执行环境启动失败：[Errno 13] Permission denied: 'python'")

    monkeypatch.setattr(sandbox, "execute", denied)
    assert await sandbox.health_check() is False
    assert sandbox.last_health_failure_code == EXEC_ENV_SPAWN_DENIED_CODE
    assert sandbox.last_health_failure is not None
    assert sandbox.last_health_failure[0] == "raised"


@pytest.mark.anyio
async def test_subprocess_sandbox_health_check_clears_verdict_when_healthy(
    monkeypatch: pytest.MonkeyPatch,
):
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox

    sandbox = SubprocessSandbox()

    async def ok(request: ExecutionRequest) -> ExecutionResult:
        return ExecutionResult(
            success=True, stdout="ok\n", stderr="", exit_code=0, duration_ms=7
        )

    monkeypatch.setattr(sandbox, "execute", ok)
    assert await sandbox.health_check() is True
    assert sandbox.last_health_failure_code is None
    assert sandbox.last_health_evidence is None


def test_exec_env_dead_lines_fork_per_reason_and_drop_unbacked_advice():
    assert set(EXEC_ENV_DEAD_USER_VISIBLE_BY_CODE) == (
        EXEC_ENV_PROBE_FAIL_CODES - {EXEC_ENV_PROBE_FAIL_CODE}
    )
    every_line = [EXEC_ENV_DEAD_USER_VISIBLE, *EXEC_ENV_DEAD_USER_VISIBLE_BY_CODE.values()]
    for line in every_line:
        assert line.startswith(EXEC_ENV_DEAD_BODY_MARKER)
        # The desktop channel is alive in exactly the cases this fires — never
        # send the user to check it.
        assert "请检查桌面" not in line
    # Security software is only ever named where a refused spawn proves it.
    named_av = [
        line for line in every_line if "安全软件" in line
    ]
    assert named_av == [EXEC_ENV_DEAD_USER_VISIBLE_BY_CODE[EXEC_ENV_SPAWN_DENIED_CODE]]
    assert exec_env_dead_user_visible(None) == EXEC_ENV_DEAD_USER_VISIBLE
    assert exec_env_dead_user_visible("exec_timeout") == EXEC_ENV_DEAD_USER_VISIBLE
    assert exec_env_dead_user_visible(EXEC_ENV_PROBE_FAIL_CODE) == EXEC_ENV_DEAD_USER_VISIBLE
    assert (
        exec_env_dead_user_visible(EXEC_ENV_NO_INTERPRETER_CODE)
        == EXEC_ENV_DEAD_USER_VISIBLE_BY_CODE[EXEC_ENV_NO_INTERPRETER_CODE]
    )


def test_exec_env_dead_notice_speaks_the_classified_cause():
    from agentcore.runtime.coordination.exec_env_dead_notice import (
        mark_and_emit_exec_env_dead_user_notice,
    )
    from agentcore.runtime.coordination.session import (
        CoordinationSession,
        clear_active_coordination,
        set_active_coordination,
    )
    from agentcore.runtime.events import EventSink, EventType

    clear_active_coordination()
    sink = EventSink()
    session = CoordinationSession(
        execution_id="exec-env-reason",
        total_workers=1,
        conversation_id="conv-env-reason",
    )
    session.event_sink = sink
    set_active_coordination(session)
    try:
        mark_and_emit_exec_env_dead_user_notice(
            execution_id="exec-env-reason", reason_code=EXEC_ENV_NO_INTERPRETER_CODE
        )
        assert session.exec_env_dead is True
        assert session.exec_env_dead_reason == EXEC_ENV_NO_INTERPRETER_CODE
        deltas = [e for e in sink._history if e.type is EventType.CONTENT_DELTA]
        assert len(deltas) == 1
        delta = deltas[0].payload.get("delta") or ""
        assert EXEC_ENV_DEAD_USER_VISIBLE_BY_CODE[EXEC_ENV_NO_INTERPRETER_CODE] in delta
        assert "请检查桌面" not in delta
    finally:
        clear_active_coordination()


def test_harvest_fallback_repeats_the_classified_cause():
    from agentcore.conversation.execution_harvest import build_harvest_fallback_content
    from agentcore.runtime.coordination.session import CoordinationSession

    session = CoordinationSession(
        execution_id="exec-env-harvest",
        total_workers=1,
        conversation_id="conv-env-harvest",
    )
    session.exec_env_dead = True
    session.exec_env_dead_reason = EXEC_ENV_SPAWN_DENIED_CODE
    content = build_harvest_fallback_content(session, kind="failure")
    assert EXEC_ENV_DEAD_USER_VISIBLE_BY_CODE[EXEC_ENV_SPAWN_DENIED_CODE] in content

    session.exec_env_dead_reason = None
    assert EXEC_ENV_DEAD_USER_VISIBLE in build_harvest_fallback_content(
        session, kind="failure"
    )
