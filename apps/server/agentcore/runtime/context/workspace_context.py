"""Per-turn ``<workspace_context>`` — structured environment facts for CEO and workers.

根治「模型环境盲」：每回合把执行位置、工作区身份、桌面通道、本回合可执行能力写成显式
事实块注入 system prompt，避免 CEO 在云端 scratch 上规划「打开本机软件」并空跑委派。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from agentcore.workspace.stage_dirs import DEBATE_DIR, RESEARCH_DIR, REVIEWS_DIR

if TYPE_CHECKING:
    from agentcore.core.types import HostAxis, PermissionAxes
    from agentcore.workspace.protocol import WorkspaceBackend

ChannelSurface = Literal["desktop", "web", "mobile", "unknown"]


@dataclass(frozen=True)
class WorkspaceGitFact:
    """Root-``.git`` fact for ``<workspace_context>`` (same rule as ``git`` tool).

    ``present=None`` = could not probe (exists/root I/O failed).
    Only the workspace root is considered — no nested scan, no parent climb.
    LocalWorkspace without Path.root still probes via ``backend.exists(".git")``.
    """

    present: bool | None
    branch: str | None = None


def _branch_from_git_head(head_text: str) -> str | None:
    line = (head_text or "").strip().splitlines()[0] if head_text else ""
    if line.startswith("ref: refs/heads/"):
        branch = line.removeprefix("ref: refs/heads/").strip()
        return branch or None
    return None


def detect_workspace_git_sync(backend: WorkspaceBackend | None) -> WorkspaceGitFact:
    """Sync probe via ``backend.root`` when available (server / sidecar Local)."""
    if backend is None:
        return WorkspaceGitFact(present=None)
    root = getattr(backend, "root", None)
    if root is None:
        return WorkspaceGitFact(present=None)
    try:
        root_path = Path(root)
        git_meta = root_path / ".git"
        if not git_meta.exists():
            return WorkspaceGitFact(present=False)
        branch: str | None = None
        if git_meta.is_file():
            # Worktree / gitfile pointer — treat as present; branch optional.
            return WorkspaceGitFact(present=True, branch=None)
        head = git_meta / "HEAD"
        if head.is_file():
            branch = _branch_from_git_head(head.read_text(encoding="utf-8", errors="replace"))
        return WorkspaceGitFact(present=True, branch=branch)
    except OSError:
        return WorkspaceGitFact(present=None)


async def detect_workspace_git(backend: WorkspaceBackend | None) -> WorkspaceGitFact:
    """Probe root ``.git`` — sync root first, else ``backend.exists`` (desktop Local)."""
    sync = detect_workspace_git_sync(backend)
    if sync.present is not None:
        return sync
    if backend is None:
        return WorkspaceGitFact(present=None)
    exists = getattr(backend, "exists", None)
    if exists is None:
        return WorkspaceGitFact(present=None)
    try:
        if not await exists(".git"):
            return WorkspaceGitFact(present=False)
    except Exception:
        return WorkspaceGitFact(present=None)
    branch: str | None = None
    read = getattr(backend, "read", None)
    if read is not None:
        try:
            branch = _branch_from_git_head(await read(".git/HEAD"))
        except Exception:
            branch = None
    return WorkspaceGitFact(present=True, branch=branch)


def format_workspace_git_line(fact: WorkspaceGitFact) -> str:
    """Single git fact line for ``<workspace_context>`` (soft tip; never a kickoff gate)."""
    scope = "仅识别工作区根 `.git`，不扫嵌套、不上溯"
    readonly = "只读 status/diff/log 无仓 → no_repo；其它写入无仓仍硬错"
    if fact.present is True:
        branch_bit = f"，分支 `{fact.branch}`" if fact.branch else ""
        return (
            f"版本控制：Git（{scope}{branch_bit}）。"
            f"{readonly}。"
        )
    if fact.present is False:
        return (
            f"版本控制：工作区根无 Git（{scope}）。"
            "写码/改工程时建议先建可回滚基线：可调 `git` 的 `init_baseline`"
            "（初始化并首提交；需用户授权；已有仓且工作区脏则不代 commit）。"
            "此提示不挡派工/开工卡。"
            f"{readonly}。"
        )
    return (
        f"版本控制：未能确认根 `.git`（{scope}）。"
        "有桌面通道时结构化 `git` 经本机执行；无通道则不可用。"
        "写码时若确认无仓，可请用户授权 `git.init_baseline` 建首基线；不挡派工/开工卡。"
        f"{readonly}。"
    )

_WEB_SURFACES: frozenset[str] = frozenset({"web", "mobile-web"})
_MOBILE_SURFACES: frozenset[str] = frozenset({"mobile", "android", "ios"})


@dataclass(frozen=True)
class ChannelProfile:
    """Single source for channel capabilities derived from ``X-Client-Platform``.

    Orthogonal to workspace ``location`` (local/server) and to auth audience
    (``parse_client_platform`` also fail-closes on missing / unknown headers).
    Missing / unknown headers fail closed — never pretend the web can drive Host.
    """

    surface: ChannelSurface
    desktop_online: bool
    can_bind_folder: bool


def resolve_channel_profile(x_client_platform: str | None) -> ChannelProfile:
    """Map raw ``X-Client-Platform`` → :class:`ChannelProfile` (fail-closed).

    Only explicit ``desktop`` is a fulfillable desktop channel. Absent / blank /
    unknown values → ``surface=unknown``, both capability flags ``False``.
    """
    raw = (x_client_platform or "").strip().lower()
    if not raw:
        return ChannelProfile(surface="unknown", desktop_online=False, can_bind_folder=False)
    if raw == "desktop":
        return ChannelProfile(surface="desktop", desktop_online=True, can_bind_folder=True)
    if raw in _WEB_SURFACES:
        return ChannelProfile(surface="web", desktop_online=False, can_bind_folder=False)
    if raw in _MOBILE_SURFACES:
        return ChannelProfile(surface="mobile", desktop_online=False, can_bind_folder=False)
    return ChannelProfile(surface="unknown", desktop_online=False, can_bind_folder=False)


def desktop_client_can_bind(x_client_platform: str | None) -> bool:
    """Thin fail-closed wrapper: folder AskOption actions need a desktop client.

    Covers ``open_local_project`` / ``bind_local_folder`` / ``grant_*``. ``None`` /
    unknown → ``False`` (same fail-closed spirit as auth ``parse_client_platform``,
    which raises rather than inventing a desktop audience).
    """
    return resolve_channel_profile(x_client_platform).can_bind_folder


def build_workspace_context(
    backend: WorkspaceBackend | None,
    *,
    desktop_online: bool,
    code_execute_enabled: bool | None = None,
    terminal_enabled: bool | None = None,
    browser_enabled: bool | None = None,
    package_install_enabled: bool | None = None,
    exec_languages: list[str] | tuple[str, ...] | None = None,
    host_axis: HostAxis | str | None = None,
    permission_axes: PermissionAxes | None = None,
    mcp_enabled: bool = False,
    mcp_label: str | None = None,
    git_fact: WorkspaceGitFact | None = None,
) -> str:
    """Render the ``<workspace_context>`` block for this turn's backend + client.

    Always returns a non-empty block when ``backend`` is set (environment is a fact,
    even for an empty cloud scratch). ``backend is None`` → ``""`` (caller omits).

    Capability line uses the same predicates as worker registry assembly
    (``execution_class_enabled_for`` / ``browser_execution_enabled_for``, including
    ``command=ask`` withhold); optional ``*_enabled`` overrides are for tests /
    probes only — not a second truth source.

    ``permission_axes`` folds ask-withhold into ``code_execute`` / ``terminal`` /
    ``browser`` so the line never contradicts the worker toolset or identity
    (案 20260803-docx-office-exec-capability-lie A). When ``host_axis`` is omitted,
    it is taken from ``permission_axes.host``.

    ``package_install`` is **not** identical to ``code_execute``: cloud needs
    ``registry_egress_available`` (gVisor + netns chokepoint); local follows
    execution-class only (pinned registry env, no host egress gate). Override
    ``package_install_enabled`` is tests/probes only.

    ``exec_languages`` is the probed (local/sidecar) or fixed (cloud) language
    surface advertised on ``code_execute``; when set and execution is on, a one-line
    interpreter fact is appended so the model never plans against a missing launcher.

    ``git_fact`` is the root-``.git`` probe (same rule as the ``git`` tool). Callers
    that already awaited :func:`detect_workspace_git` should pass it; otherwise a
    sync root probe runs. Soft tip only — never a kickoff / durable-pause gate.
    """
    if backend is None:
        return ""

    if host_axis is None and permission_axes is not None:
        host_axis = permission_axes.host

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
        artifact_line = (
            "产物出口：你写入工作区的文件位于用户本机目录，"
            "用户可在「文件」面板查看；HTML 同样走「完整预览」进右坞「浏览器」标签"
            "（或本机直接打开，按用户习惯）。"
        )
        # 本机有 Host 出口，但仍禁 Key 明文进工作区（案 B 与位置正交）。
        egress_line = (
            "出站网络：本机 code_execute / terminal 可走用户机器网络；"
            "仍【禁止】把用户粘贴的第三方 API Key 写入工作区明文——"
            "脚本脚手架用环境变量占位，由用户本机自备；无原生生图工具时勿假装平台代出图。"
        )
    else:
        location_line = "执行位置：云端沙箱（服务端）"
        # 裸聊默认云 scratch：空树 ≠ 本机/已打开仓库。对模型显式纠偏，避免把宿主路径当项目。
        identity_line = (
            f"工作区身份：本会话云端草稿/临时文件空间（根标签 `{root_label}`）——"
            "不是用户本机目录，也不是用户本机已打开的仓库或项目工作区。"
        )
        # Host 定案 §3.4: 云 reach 与 host= 正交——工作区在云；本机 Host 以能力行为准。
        reach_line = (
            "云端工作区文件在云端沙箱，不是用户本机磁盘；"
            "本机 Host（音响/系统信息/打开设置等）另计，以能力行 host= 为准——"
            "host=已装配时可经桌面回填通道调用 host_*；"
            "host=未装配时勿假装已查本机、勿假设能打开或安装用户机器上的软件；"
            "空树只表示本会话云端草稿尚无文件，勿当成「本机空项目」或宿主机器上的 Git 仓库。"
        )
        artifact_line = (
            "产物出口：你写入工作区的文件保存在云端工作区（不在用户本机），"
            "用户可在桌面端「文件」面板查看与下载；"
            "HTML 完整效果请指引用户点产物卡或文件横幅的「完整预览」"
            "（打开右坞「浏览器」标签，应用内渲染，非系统浏览器）；"
            "不要让用户去本机磁盘查找这些文件，"
            "也不要声称文件已在用户电脑上、或让其在本地「双击打开」。"
        )
        # 案 20260803-image-gen-byok-egress-boundary A：云沙箱 code_execute 默认
        # --network=none；有执行 ≠ 能代调用户 Key 出网（含生图）。
        egress_line = (
            "出站网络：云端 code_execute 默认无任意 HTTPS 出口（`--network=none`；"
            "装包白名单 egress 仅 test_run install，≠通用出网）；"
            "【禁止】承诺「云端用用户 Key 代调外部生图/中转站 API 并把图写进工作区」；"
            "允许：① 说明无原生生图工具并拒接代出图；② 引导桌面端/本机有出口环境；"
            "③ 明确「只帮写本机脚本、平台不出图」。"
            "【禁止】把第三方 API Key 写入工作区明文（含 env）；browser_* 另计"
            "（隔离浏览器，≠ code_execute 出网）。"
        )

    if desktop_online:
        grant_line = (
            "区外目录：桌面在线时只读用工具 `external_mount_readonly`"
            "（path 和/或 well_known+target_name；静默、无决策卡）；"
            "整理用 ask_user 选项 `action=grant_organize_folder`（仍须确认）。"
            "【口头同意闭环】用户已明确「可以整理 / 允许」→ 须立刻发带 "
            "`grant_organize_folder` 的确认卡并履约；禁止空心「等待确认」/纯文本劝授权。"
            "成功后以 `external/<别名>/…` 访问（经桌面通道、仅本次对话、可撤销）。"
            "与工作区绑定正交——不必先改绑或打开本地项目。"
            "「看桌面/看本机某目录」只走 `external_mount_readonly`：直接调用，"
            "【禁止】为只读新发 `grant_readonly_folder` 卡；"
            "已点名常见目录+任务 → well_known（desktop/downloads/documents），"
            "已知子名带 target_name；禁止首轮文本题要文件名/绝对路径"
            "（挂载后在 external/ 匹配；定位歧义 → 同一题 2～3 个 "
            "`grant_organize_folder` choice，各带不同 well_known/target_name/path，"
            "仍非系统选文件夹）；"
            "找不到 → 工具明确失败（不再弹系统选文件夹）；"
            "【失败分型】对人区分「没找着」vs「定位到了但本机不让读」；"
            "只读挂过 ≠ 已授写，同目录升整理须再确认；"
            "禁止要用户手填绝对路径；禁止用 code_execute/terminal/host_shell "
            "探主机家目录找路径。"
        )
        if is_local:
            desktop_line = (
                "客户端通道：桌面端在线（本机执行通道可用）。"
                "本机传统/已绑工程会话：「打开项目 / 跑起来看一下」=跑**当前**项目"
                "（terminal 启服报 URL），勿再弹 open_local_project 建新本地工作区；"
                "换工程优先引导 Composer「导入到云 / 连接 Git」"
                "（勿默认催 create_project 过写盘闸；裸聊写盘缺桌由运行时自动建云桌）；"
                "本机传统换开合法非默认（≠离线）。"
            )
        else:
            desktop_line = (
                "客户端通道：桌面端在线——本机相关出路按意图分流（立即发 ask_user 卡，"
                "勿用纯文本解释或询问；完成前不要委派本机任务）："
                "① 【新产品路径·云协作推荐】要本机目录进工作区 → **优先**引导 Composer"
                "「导入到云 / 连接 Git」后再派；"
                "同指挥面云 `create_project` 仅用户明确要求新建或显式多线先建"
                "（禁止为过写盘闸而建；裸聊写盘缺桌由运行时自动建云桌）；"
                "本机传统（合法非默认，≠离线）→ 可发 `open_local_project` / "
                "`register_local_project` / `bind_local_folder`，勿当默认推荐、"
                "勿与云平级主推；"
                "② 看/分析本机某目录 → `external_mount_readonly`（只读静默；"
                "【禁止】为只读新发 grant_readonly_folder）；整理 → "
                "`grant_organize_folder`（与①正交，勿改绑冒充；"
                "口头同意须立刻发卡；歧义可 2～3 个具体文件夹候选）；"
                "③ 「优化/改项目」≠默认开项目卡：已有附件且用户收窄本轮范围（先这些/就这些）→ "
                "先读材料与工作区已有产物动手，勿把开项目/绑本地当开工前置；"
                "「在哪工作」仅新建会话可选（云协作推荐：快速对话/云项目/导入·连 Git；"
                "本机传统可选非默认），"
                "勿引导用户去设置改模式、勿推销本机草稿当默认。"
            )
    else:
        # desktop_online=False covers missing header, unknown surface, and true
        # non-desktop clients — never accuse a device form (Web/手机) by default.
        # 案 20260803-cloud-local-root-auth-where A：用户自称已在桌面时仍以通道事实
        # 复检（对照 b0a9）；禁「就好办了」与臆造设置/Folders 路径。
        desktop_line = (
            "客户端通道：桌面回填通道未连接——"
            "打开本地项目、本机文件夹绑定、区外目录授权均须官方桌面客户端且通道已连接，"
            "当前会话无法履约；请引导用户在桌面客户端打开本对话，或前往 "
            "https://fashitianxia.xyz/download 下载安装桌面端后再操作；"
            "勿发 grant_* / bind_local_folder / open_local_project / "
            "register_local_project 选项卡冒充可授权。"
            "【通道复检铁律】用户自称「已装桌面 / 正在用客户端 / 现在用的就是」时："
            "必须以本回合能力行 `host`/`local_open` 与本通道行为准复检，口述不得覆盖结构化事实；"
            "`host=未装配` 或 `local_open=未装配` 时禁止「就好办了 / 桌面就好办 / "
            "现在用的是桌面就好办」类话术；应诊断通道仍未接通"
            "（可能仍在网页、或桌面未打开【本对话】、或状态栏通道未连），并复述固定步骤："
            "① 官网下载安装桌面端（若尚未）→ ② 在桌面客户端打开【本对话】→ "
            "③ 确认状态栏桌面回填通道已连接（host/local_open=已装配）→ "
            "④ 用 Composer「导入到云 / 连接 Git」（云协作推荐），"
            "或用户明确要求新建时云 `create_project`（禁止为过写盘闸而建；"
            "裸聊写盘缺桌由运行时自动建云桌），"
            "或本机传统 open/register/bind（合法非默认，≠离线），"
            "或按意图 grant_organize / external_mount_readonly；"
            "禁止臆造「设置→Folders / 侧栏授权页」等非产品真源入口路径——"
            "只指真源入口名（Composer 导入·连 Git / 云新建 / 本机传统）与官网下载链。"
        )
        grant_line = (
            "区外目录授权仅桌面端可用；当前客户端无法履行。"
            "铁律：仅当 mounts 行写明「本对话已授权区外目录…」时，才可声称已授权"
            "或可访问本机目录；尚无授权时禁止说「授权已确认」。"
            "用户问「授权在哪里」且通道未接时：复述上列固定步骤，禁臆造设置页路径。"
        )

    mounts = getattr(backend, "_mounts", None) or {}
    if mounts:
        parts = []
        for a, m in mounts.items():
            mode = getattr(m, "mode", None) or (
                "readonly" if getattr(m, "readonly", True) else "organize"
            )
            mode_zh = "只读" if mode == "readonly" else "整理"
            parts.append(
                f"`external/{a}/`（{getattr(m, 'label', a)}，{mode_zh}）"
            )
        mounts_line = "本对话已授权区外目录：" + "；".join(parts) + "。"
    else:
        mounts_line = (
            "本对话尚无会话级区外目录授权。"
            "（未见「本对话已授权区外目录…」则禁止声称授权已确认或可访问本机目录。）"
        )

    if code_execute_enabled is not None:
        exec_on = code_execute_enabled
    else:
        from agentcore.tools.builtin import execution_class_enabled_for

        exec_on = execution_class_enabled_for(backend, permission_axes)
    # terminal is execution_class ∧ local_only — same ask withhold as registry.
    term_on = (
        terminal_enabled if terminal_enabled is not None else is_local and exec_on
    )
    if browser_enabled is not None:
        browser_on = browser_enabled
    else:
        from agentcore.tools.builtin import browser_execution_enabled_for

        # Registry: include_browser = include_execution ∧ browser_execution_enabled_for.
        browser_on = exec_on and browser_execution_enabled_for(backend)
    # B1：装配事实闩锁 → 收口禁在未装配时声称已开浏览器（结构化对账，非扫气泡）。
    from agentcore.runtime.closing_posture import note_browser_assembled

    note_browser_assembled(browser_on)
    # local_open = 本机工作区可让用户直接打开产物（非 L3 浏览器工具；与 location 同事实）。
    local_open_on = is_local
    # Host 已装配 ⇔ host≠off ∧ 桌面回填通道可达（desktop_online）。
    host_off = False
    if host_axis is not None:
        host_val = getattr(host_axis, "value", None) or str(host_axis)
        host_off = host_val == "off"
    host_on = desktop_online and not host_off
    mcp_on = bool(mcp_enabled) if mcp_label is None else mcp_label == "已装配"
    mcp_cap = mcp_label if mcp_label is not None else ("已装配" if mcp_enabled else "未装配")
    # 装包 ≠ 跑代码：云端另需 registry_egress（netns）；本机不吃该主机门。
    if package_install_enabled is not None:
        pkg_on = package_install_enabled
    elif not exec_on:
        pkg_on = False
    elif is_local:
        pkg_on = True
    else:
        from agentcore.tools.sandbox.egress import registry_egress_available

        pkg_on = registry_egress_available()
    caps: list[str] = []
    caps.append(f"code_execute={'已装配' if exec_on else '未装配'}")
    caps.append(f"package_install={'已装配' if pkg_on else '未装配'}")
    caps.append(f"terminal={'已装配' if term_on else '未装配'}")
    caps.append(f"browser={'已装配' if browser_on else '未装配'}")
    caps.append(f"local_open={'已装配' if local_open_on else '未装配'}")
    caps.append(f"host={'已装配' if host_on else '未装配'}")
    caps.append(f"mcp={mcp_cap}")
    capability_line = "本回合执行能力：" + "；".join(caps) + "。"
    if is_local:
        if pkg_on:
            package_guide_line = (
                "装包指引：package_install=已装配（本机执行环境；钉源 env，"
                "不吃主机 registry_egress）——`test_run` check=install 可装项目依赖；"
                "装本机软件仍须 host=已装配 + host_package_install。"
            )
        else:
            package_guide_line = (
                "装包指引：package_install=未装配（本回合无执行环境）——"
                "勿空转声称可装依赖；对照 code_execute=。"
            )
    elif pkg_on:
        package_guide_line = (
            "装包指引：package_install=已装配（gVisor 健康 + 包装源 allowlist egress/"
            "netns）——`test_run` check=install 可装依赖；≠通用 HTTPS 出网"
            "（对照「出站网络」行）；任意 URL 落盘用 download_url。"
        )
    elif exec_on:
        package_guide_line = (
            "装包指引：package_install=未装配（云端能跑代码 ≠ 能装依赖；"
            "另需 netns/registry_egress chokepoint）——"
            "勿空转声称可 npm/pip/uv install；走结构自检 / export_to_local / 本机命令；"
            "【禁止】把仅结构自检说成外环验绿。"
        )
    else:
        package_guide_line = (
            "装包指引：package_install=未装配（云端执行沙箱亦未开；"
            "装包腿随执行类一并不可用）——"
            "勿空转声称可装依赖；对照执行指引；勿再引导「导入到云」当修复；"
            "【禁止】把仅结构自检说成外环验绿。"
        )
    if exec_on:
        exec_guide_line = None
    elif is_local:
        exec_guide_line = (
            "执行指引：code_execute=未装配（本机执行类未开）——"
            "勿空转声称可跑码；可引导 Composer「导入到云 / 连接 Git」或诚实标缺口；"
            "本机传统 open/bind 合法非默认（≠离线）。"
        )
    else:
        from agentcore.runtime.delegate.exec_env_remediation import (
            cloud_sandbox_failure_hint,
        )

        failure = cloud_sandbox_failure_hint()
        failure_clause = f"探测={failure}；" if failure else ""
        exec_guide_line = (
            "执行指引：code_execute=未装配（已是云端会话，沙箱不可用；"
            f"{failure_clause}"
            "【禁止】再引导「导入到云 / 连接 Git」当修复）——"
            "可选稍后重试 / export_to_local 本机跑 / 本机传统（合法非默认）；"
            "禁止假跑、禁止把结构自检说成验绿。"
        )

    if not desktop_online:
        mcp_guide_line = (
            "本机 MCP 指引：mcp=未装配（无桌面回填通道）——"
            "勿调用 mcp_*、勿假装已接本地 MCP Server；"
            "勿将通道缺失说成用户在用 Web/手机。"
            "同轮可开工（按序，禁多轮复读「为什么不行」）："
            "① 手脑协作——用户可贴工具输出/截图你分析（用户已愿动手时优先；一等路径）；"
            "② 用不依赖 MCP 的路径推进；"
            "③ 引导在桌面回填已连接的会话重试。"
        )
    elif mcp_on:
        mcp_guide_line = (
            "本机 MCP 指引：mcp=已装配（经桌面 stdio 回填，非云进程直连本机）。"
            "仅 worker 持 MCP 工具（一律需审批）；CEO 不直持。"
            "工具名形如 mcp_<server>_<tool>；失败时如实说明，勿编造结果。"
        )
    else:
        mcp_guide_line = (
            f"本机 MCP 指引：mcp={mcp_cap}——"
            "本回合无可用 MCP 工具（未配置 / 握手失败已降级）；"
            "勿调用 mcp_*、勿假装已接本地 MCP。"
            "同轮可开工：手脑（用户贴相关输出）或不依赖 MCP 的路径；纯聊不受影响；"
            "禁多轮复读「为什么不行」。"
        )
    if host_off:
        host_guide_line = (
            "本机 Host 指引：host=未装配（用户已关本机协助 / host=off）——"
            "勿调用 host_*、勿假装已查声卡或本机系统信息；"
            "工作区 terminal / code_execute 仍可能已装配（host=off ≠ 整机只读）。"
            "【三分日志·勿混称】OS Host 事件日志不可用（host=off）；"
            "任务/沙箱/构建 stdout → terminal read / code_execute / test_run；"
            "产品 AI 对话日志 → search_conversations。"
            "同轮可开工：通识边界内答 / ask_user 换可走能力；禁多轮复读「为什么不行」。"
        )
    elif host_on:
        host_guide_line = (
            "本机 Host 指引：host=已装配（经桌面回填通道，非云进程直探本机）。"
            "本机排查可先用 L1 host_info / host_audio_devices / host_os_log_summary，"
            "也可直接 host_shell（短时本机命令，不必先 delegate）；结构化 host_* 仍作快捷路径。"
            "装常用软件（Docker/VS Code 等）须 delegate worker 用 host_package_install"
            "（winget/brew/apt 点名包+恒确认）；禁止 host_shell 静默跑任意 exe。"
            "长驻进程（dev server）用 terminal，禁止 host_shell 启服。"
            "【三分日志·勿混称】① OS Host 事件日志 → host_os_log_summary（有界/脱敏；"
            "禁止 host_shell 倾倒 Get-WinEvent/journalctl 或扫任意 *\\logs）；"
            "② 任务/沙箱/构建 stdout → terminal read / code_execute / test_run"
            "（云侧任务日志亦走此主路径，不提供整机 Event Log）；"
            "③ 产品 AI 对话日志 → search_conversations。"
            "禁止用通识 FAQ 冒充已查本机；打开声音设置 / L3 动作用 worker"
            "（host_open_settings / host_audio_set_default / host_package_install 等）。"
        )
    else:
        host_guide_line = (
            "本机 Host 指引：host=未装配（无桌面回填通道）——"
            "勿调用 host_*、勿假装已查声卡或本机系统信息。"
            "【三分日志·勿混称】无本机 OS Host 事件日志通道；"
            "云/沙箱任务日志 = terminal read / code_execute / test_run（既有 stdout 主路径，"
            "不新建整机 Event Log 工具）；产品 AI 对话日志 = search_conversations。"
            "同轮可开工（按序，禁多轮复读「为什么不行」）："
            "① 手脑协作——请用户本机自查后贴现象/截图你分析（用户已愿动手时优先；一等路径）；"
            "② 通识边界内答或 ask_user；"
            "③ 引导桌面回填已连接的会话重试。"
        )
    if browser_on:
        # Path capability follows real host_kind (Bridge→local；过桥无桥→sandbox).
        # Test override ``browser_enabled=True`` without probing: local→Bridge guide.
        use_local_bridge_guide = is_local
        if browser_enabled is None:
            from agentcore.tools.builtin import browser_host_kind_for

            use_local_bridge_guide = browser_host_kind_for(backend) == "local"
        if use_local_bridge_guide:
            path_capability = (
                "桌面 Local Bridge 可打开本会话工作区相对 HTML 路径"
                "（如 `site/index.html`，与用户「完整预览」同源 workspace://）；"
                "公网仍用完整 http(s)；不支持 file://。"
                "打开后可继续 click/type/snapshot。"
            )
        else:
            path_capability = (
                "当前为云端沙箱浏览器：仅支持公网 http(s)；"
                "本会话 HTML 相对路径不可测——请指引用户点产物「完整预览」，"
                "禁止假装已用 browser_navigate 打开工作区页。"
            )
        browser_guide_line = (
            "浏览器指引：本回合已装配 browser_*"
            "（navigate/click/type/scroll/snapshot/console 由 CEO 可直持；screenshot 仅 worker）。"
            "页面行为异常或发送未生效时先用 browser_console 取 JS 错误再决定是否继续点选；"
            + path_capability
            + "用户要「用浏览器打开 / 右坞打开 / 直播 / 帮我看页面」或已打开页短操作"
            "（搜一下 / 点一下 / 填一下）时："
            "必须你自己用对应 `browser_*` 完成"
            "（右坞会直播；**【禁止】**为此 `delegate`；「随便搜」省略过重验收），"
            "短操作或 navigate 成功即可收工（已打开即可，**【禁止】**口头假验收）；"
            "仅用户明确要「验收 / 截图 / 确认渲染」才 `delegate` 做 screenshot"
            "（screenshot 失败勿多轮空转补验）；"
            "「跑起来 / 打开看一下」≠必须 navigate。"
            "禁止编造 browser_open 等未列出的工具名；"
            "禁止只用 read_url / web_search 交差并假装已打开浏览器。"
            "仅当用户只要摘要/标题且未点名浏览器时，才可用 read_url。"
            "需要登录时 ask_user(browser_login=true) 让用户在右坞「浏览器」接管登录"
            "（归还后点「已登录，继续」）；模型永不代填密码。"
            "勿声称已替用户打开系统浏览器。"
        )
    else:
        if is_local:
            browser_base = (
                "浏览器指引：本回合 browser=未装配"
                "（无本机 Bridge 且本进程无可用云端隔离浏览器）——"
                "勿调用 browser_*、勿假装已打开或直播页面。"
            )
            how_enable = (
                "装配启用：真·本地引擎需桌面 Local Chromium Bridge 健康；"
                "无 Bridge 且无 gVisor 时不可装配，禁止假成功。"
            )
        elif desktop_online:
            browser_base = (
                "浏览器指引：本回合 browser=未装配（无云端隔离浏览器）——"
                "勿调用 browser_*、勿假装已打开或直播页面。"
            )
            how_enable = (
                "装配启用：云端路径需 gVisor/沙箱/netns 健康；"
                "本机传统/已绑会话可走本机 Bridge"
                "（或过桥会话在云侧沙箱健康时装配 sandbox）；"
                "云协作仍推荐；本机传统 open/bind 合法非默认（≠离线）。"
            )
        else:
            browser_base = (
                "浏览器指引：本回合 browser=未装配（无云端隔离浏览器）——"
                "勿调用 browser_*、勿假装已打开或直播页面。"
            )
            how_enable = (
                "装配启用：当前非桌面会话无法绑定本机 Local Bridge；"
                "云端路径需 gVisor/沙箱/netns 健康，或换桌面端。"
            )
        # 缺能力 → 同轮可开工排序；人手为一等路径（禁「仅补救/非主路径」反信号）。
        same_round = (
            "用户要「用浏览器打开 / 右坞打开 / 直播 / 接管登录」时："
            "一句说明未装配即可，同轮给可开工路径（按序优先，禁多轮复读「为什么不行」）："
            "① 手脑协作——用户可贴数/截图/复制页面文本，你当脑分析推进"
            "（用户已愿动手时优先此路；一等可开工路径，非补救）；"
            "② read_url / web_search 作文本摘录，须标明「非右坞浏览器、未直播开页」，"
            "禁止静默交差让用户以为已打开浏览器；"
            "③ " + how_enable
        )
        product_path = (
            "装配后：CEO 直调 browser_navigate / snapshot / type / click "
            "打开或短操作（「随便搜」省略过重验收；截图验收仍可 delegate）→"
            "需要登录则 ask_user(browser_login=true) →"
            "用户在右坞「浏览器」接管 → 点「已登录，继续」；"
            "勿把扫本机 Cookie / 系统浏览器代登说成产品接管路径。"
        )
        browser_guide_line = browser_base + same_round + product_path

    # Prefer explicit languages; else a probe cached on the backend.
    langs = exec_languages
    if langs is None:
        langs = getattr(backend, "_exec_languages", None)
    interpreters_line: str | None = None
    if exec_on and langs is not None:
        from agentcore.tools.sandbox.exec_languages import format_interpreters_line

        interpreters_line = format_interpreters_line(tuple(langs))

    # 约定文档布局（始终可见）：三行出口 + 一句边界。只陈述路径事实，不注入文档正文进 <rules>。
    dossier_research_line = f"约定文档出口·调研/讨论：`{RESEARCH_DIR}/`"
    dossier_debate_line = f"约定文档出口·辩论副产物：`{DEBATE_DIR}/`"
    dossier_reviews_line = f"约定文档出口·审查：`{REVIEWS_DIR}/`"
    dossier_boundary_line = (
        "约定文档边界：讨论/调研/审查类交付写此树；用户工程源码仍写业务路径；"
        "向用户报产物路径须用上列完整前缀，禁缩短成裸 reviews/research/debate。"
    )
    # Git fact: prefer caller probe (async Local); else sync root; never gates kickoff.
    resolved_git = git_fact if git_fact is not None else detect_workspace_git_sync(backend)
    git_line = format_workspace_git_line(resolved_git)

    # 跨项目并行指挥（事实面短教；整条 HOW 见 consult team_orchestration_advanced）。
    # 与 desktop_line 的 open/register/bind 分流互补，不替代。
    # 读=只读跨桌工具；写=delegate+target_folder_id（与双模式 §五 / 编排器一致）。
    cross_project_line = (
        "跨项目指挥：默认工作区=出生桌（通用 file_* 只绑出生桌）；"
        "摸已登记项目→只读跨桌 `list_project_dir` / `read_project_file`"
        "（`folder_id`+相对路径；不改挂载、不写目标桌记忆）；"
        "【禁止】以「云端读不到本地」为由改绑/open/mount 冒充跨仓读；"
        "写/改盘→`list_projects` / `resolve_project` 得 id"
        "（歧义 `ask_user` choice，禁猜最近）后同一次 `delegate` 各 task 填"
        "`target_folder_id`（换桌+记忆跟桌；不改本会话 folder_id）；"
        "空/近空→先 `ask_user` 钉目标，禁连续 file_list 确认空；"
        "开发双仓≠open/register/bind/`external_mount_readonly` 冒充"
        "（挂载=区外只读，正交；写仍派工换桌）；"
        "有出生未点名=默认桌；无出生：纯对话/只读可派（scratch 禁写）；"
        "裸聊写盘缺桌由运行时自动建云桌，勿先 ask_user/create_project；"
        "多项目写盘须点名禁默写 scratch；"
        "仅用户明确新建/显式多线先建：云 `create_project`（只建云）/ "
        "Composer「导入到云 / 连接 Git」（云协作推荐）；"
        "本机传统 `open_local_project` / `register_local_project` / `bind_local_folder` "
        "合法非默认（≠离线），勿与云平级主推；"
        "ask齐点名新建→先建齐再同次派；拒后禁塌缩→consult skill；"
        "多本机传统/local 同回合可并行；协作图不改。"
    )

    body_lines = [
        location_line,
        identity_line,
        reach_line,
        artifact_line,
        egress_line,
        dossier_research_line,
        dossier_debate_line,
        dossier_reviews_line,
        dossier_boundary_line,
        git_line,
        cross_project_line,
        desktop_line,
        grant_line,
        mounts_line,
        capability_line,
        package_guide_line,
        *([exec_guide_line] if exec_guide_line else []),
        host_guide_line,
        mcp_guide_line,
        browser_guide_line,
    ]
    if interpreters_line is not None:
        body_lines.append(interpreters_line)
    body = "\n".join(body_lines)
    return f"<workspace_context>\n{body}\n</workspace_context>"
