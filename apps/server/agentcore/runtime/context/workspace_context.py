"""Per-turn ``<workspace_context>`` — structured environment facts for CEO and workers.

根治「模型环境盲」：每回合把执行位置、工作区身份、桌面通道、本回合可执行能力写成显式
事实块注入 system prompt，避免 CEO 在云端 scratch 上规划「打开本机软件」并空跑委派。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from agentcore.workspace.protocol import WorkspaceBackend


def desktop_client_can_bind(x_client_platform: str | None) -> bool:
    """Whether the calling client can fulfil ``AskOption.action=bind_local_folder``.

    Only the Electron desktop app renders the folder-picker action. Mobile sends
    ``mobile-web`` / ``mobile``; admin is unrelated. Absent header defaults to desktop
    (legacy tests / curl — same posture as ``parse_client_platform``).
    """
    raw = (x_client_platform or "desktop").strip().lower()
    return raw == "desktop"


def build_workspace_context(
    backend: WorkspaceBackend | None,
    *,
    desktop_online: bool,
    code_execute_enabled: bool | None = None,
    terminal_enabled: bool | None = None,
) -> str:
    """Render the ``<workspace_context>`` block for this turn's backend + client.

    Always returns a non-empty block when ``backend`` is set (environment is a fact,
    even for an empty cloud scratch). ``backend is None`` → ``""`` (caller omits).
    """
    if backend is None:
        return ""

    location: Literal["server", "local"] = backend.location
    root_label = (getattr(backend, "root_label", None) or "workspace").strip() or "workspace"
    # Sidecar reuses ServerWorkspace(location=local) with direct Path I/O; LocalWorkspace
    # is the remote desktop-channel path. Both are "用户本机" for the model.
    is_local = location == "local"
    channel = getattr(backend, "_channel", None)
    is_remote_local = is_local and channel is not None

    if is_local:
        location_line = (
            "执行位置：用户本机"
            + ("（经桌面通道遥控）" if is_remote_local else "（本机引擎 / sidecar）")
        )
        identity_line = f"工作区身份：本地目录（根标签 `{root_label}`）"
        reach_line = "本机应用、本机文件与本机终端均可按已装配工具触达。"
    else:
        location_line = "执行位置：云端沙箱（服务端）"
        identity_line = f"工作区身份：云端临时空间（根标签 `{root_label}`）"
        reach_line = (
            "云端沙箱触达不了用户的电脑、本机应用与本机文件；"
            "不要假设能打开或安装用户机器上的软件。"
        )

    if desktop_online:
        if is_local:
            desktop_line = "客户端通道：桌面端在线（本机执行通道可用）。"
        else:
            desktop_line = (
                "客户端通道：桌面端在线——可用 ask_user 选项 "
                "`action=bind_local_folder` 引导用户绑定本地文件夹，"
                "以获得本机执行能力；绑定完成前不要委派本机任务。"
            )
    else:
        desktop_line = (
            "客户端通道：桌面端不在线（当前为 Web / 移动端等非桌面会话）——"
            "无法发起本机文件夹绑定；需要本机能力时如实说明限制。"
        )

    exec_on = code_execute_enabled
    if exec_on is None:
        from agentcore.tools.builtin import code_execution_enabled_for

        exec_on = code_execution_enabled_for(backend)
    term_on = is_local if terminal_enabled is None else terminal_enabled
    caps: list[str] = []
    caps.append(f"code_execute={'已装配' if exec_on else '未装配'}")
    caps.append(f"terminal={'已装配' if term_on else '未装配'}")
    capability_line = "本回合执行能力：" + "；".join(caps) + "。"

    body = "\n".join(
        [
            location_line,
            identity_line,
            reach_line,
            desktop_line,
            capability_line,
        ]
    )
    return f"<workspace_context>\n{body}\n</workspace_context>"
