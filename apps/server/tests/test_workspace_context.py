"""Tests for ``<workspace_context>`` environment-facts injection.

去重定案（一条纪律只留一个权威位置）：本块**只陈述本回合事实**——位置、能力行、挂载、
产物出口路径、某能力装没装配。「该怎么做 / 禁止什么」的 HOW 归 ``_CEO_CORE_HINT``（CEO 侧）
或共享基座（全员侧）。因此这里的用例成对写：事实留在 ``out``，HOW 断言指向核。
"""

from agentcore.runtime.context.workspace_context import (
    build_workspace_context,
    desktop_client_can_bind,
    resolve_channel_profile,
)
from agentcore.runtime.resolve.prompt import _CEO_CORE_HINT, assemble_system_prompt
from agentcore.tools.builtin import build_ceo_tool_registry


class _FakeBackend:
    def __init__(self, location: str, root_label: str = "workspace", *, channel=None) -> None:
        self.location = location
        self.root_label = root_label
        if channel is not None:
            self._channel = channel


def test_desktop_client_can_bind_fail_closed():
    assert desktop_client_can_bind(None) is False
    assert desktop_client_can_bind("") is False
    assert desktop_client_can_bind("desktop") is True
    assert desktop_client_can_bind("web") is False
    assert desktop_client_can_bind("mobile") is False
    assert desktop_client_can_bind("mobile-web") is False
    assert desktop_client_can_bind("android") is False
    assert desktop_client_can_bind("admin") is False


def test_resolve_channel_profile_fail_closed_and_surfaces():
    unknown = resolve_channel_profile(None)
    assert unknown.surface == "unknown"
    assert unknown.desktop_online is False
    assert unknown.can_bind_folder is False

    blank = resolve_channel_profile("  ")
    assert blank.surface == "unknown"
    assert blank.desktop_online is False

    desktop = resolve_channel_profile("desktop")
    assert desktop.surface == "desktop"
    assert desktop.desktop_online is True
    assert desktop.can_bind_folder is True

    web = resolve_channel_profile("web")
    assert web.surface == "web"
    assert web.desktop_online is False
    assert web.can_bind_folder is False

    mobile_web = resolve_channel_profile("mobile-web")
    assert mobile_web.surface == "web"
    assert mobile_web.desktop_online is False

    mobile = resolve_channel_profile("mobile")
    assert mobile.surface == "mobile"
    assert mobile.desktop_online is False

    android = resolve_channel_profile("android")
    assert android.surface == "mobile"
    assert android.can_bind_folder is False

    # Unknown tokens fail closed (do not legacy-default to desktop).
    admin = resolve_channel_profile("admin")
    assert admin.surface == "unknown"
    assert admin.desktop_online is False


def test_web_and_missing_header_ceo_registry_omits_host():
    """Acceptance: web / missing header → no host_* on CEO registry (web-safe)."""
    web_names = {s.name for s in build_ceo_tool_registry(desktop_online=False).list_all()}
    assert not any(n.startswith("host_") for n in web_names)

    # Profile wiring: web / None → desktop_online False → same roster.
    assert resolve_channel_profile("web").desktop_online is False
    assert resolve_channel_profile(None).desktop_online is False
    missing = {
        s.name
        for s in build_ceo_tool_registry(
            desktop_online=resolve_channel_profile(None).desktop_online
        ).list_all()
    }
    assert not any(n.startswith("host_") for n in missing)

    desktop_names = {
        s.name
        for s in build_ceo_tool_registry(
            desktop_online=resolve_channel_profile("desktop").desktop_online
        ).list_all()
    }
    assert any(n.startswith("host_") for n in desktop_names)

def test_cloud_scratch_facts():
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    assert out.startswith("<workspace_context>")
    assert "执行位置：云端沙箱" in out
    assert "云端草稿/临时文件空间" in out
    assert "不是用户本机目录" in out
    assert "不是用户本机已打开的仓库" in out
    assert "空树" in out
    assert "本机空工程" in out or "宿主机器" in out
    assert "触达不了用户的电脑" not in out
    assert "本机 Host" in out or "host=" in out
    assert "host=已装配" in out
    assert "bind_local_folder" in out  # 本机传统可教
    assert "open_local_project" in out
    assert "register_local_project" in out
    assert "导入到云" in out or "连接 Git" in out
    assert "合法非默认" in out or "非默认" in out
    assert "本机传统" in out
    assert "改导" not in out  # skill/context 不得写 Ask 改导导入
    # 跨文件夹：事实层只留「默认坐哪张桌」，整条 HOW 归 ceo_core（去重定案）
    assert "出生桌" in out
    assert "跨文件夹指挥" not in out
    assert "target_folder_id" not in out
    assert "list_folders" not in out and "resolve_folder" not in out
    assert "可能降级" not in out
    hint = _CEO_CORE_HINT
    assert "【跨文件夹 / 空壳 kickoff】" in hint
    assert "list_folders" in hint and "resolve_folder" in hint
    assert "target_folder_id" in hint
    assert "create_folder" in hint
    # 嵌套：resolve 按路径，歧义候选带完整路径。
    assert "按路径解析" in hint and "完整路径" in hint
    assert "自动建云文件夹" in hint
    assert "禁猜最近" in hint
    assert "默写 scratch" in hint
    assert "协作图不因换桌改变" in hint
    assert "先建齐再同次派" in hint
    assert "拒后禁塌缩" in hint
    # 跨文件夹读写通吃派工换桌；CEO 只读跨桌仅认桌（禁「云端读不到本地」当唯一路径）
    assert "list_folder_dir" in hint and "read_folder_file" in hint
    assert "认桌" in hint
    assert "云端读不到本地" in hint
    assert "delegate" in hint
    # 空壳先问 + 开发双仓 ≠ open/bind/挂载冒充（同属 HOW）
    assert "ask_user" in hint
    assert "file_list" in hint
    assert "开发双仓" in hint
    # 区外授权：事实层留通道与工具名，判据与闭环归核
    assert "external_mount_readonly" in out
    assert "grant_organize_folder" in out
    assert "与工作区绑定正交" in out
    assert "区外目录授权需先处在本地工作区" not in out
    assert "云端无法直接授权本机区外路径" not in out
    assert "选择器兜底" not in out
    assert "口头同意闭环" not in out
    assert "失败分型" not in out
    # 口头同意闭环 + 歧义 2～3 候选 + 失败分型：核里各一份
    assert hint.count("【口头同意闭环】") == 1
    assert "等待确认" in hint
    assert "2～3" in hint
    assert hint.count("【失败分型】") == 1
    assert "没找着" in hint
    assert "为只读新发 `grant_readonly_folder`" in hint
    # 授权后发现：禁首轮文本题要文件名；须提示 well_known —— 都归核
    assert hint.count("【授权后发现】") == 1
    assert "well_known" in hint
    assert "首轮文本题要文件名/绝对路径" in hint
    assert "well_known" not in out
    assert "在哪工作" in out
    assert "仅新建会话" in out
    assert "ask_user" in out  # 本机整理仍走卡
    assert "勿引导用户去设置改模式" in out
    # 定案 A：优化项目 ≠ 默认催开项目；附件收窄范围时先干活（后半句归核）。
    assert "≠默认开文件夹卡" in out
    assert "开工前置" not in out
    assert "【本轮材料收窄】" in hint
    assert "不得把开文件夹/绑本地当开工前置" in hint
    assert "不可改绑" not in out
    assert "严禁引导" not in out
    assert "本机草稿" not in out or "勿推销本机草稿" in out
    assert "本会话发绑定卡" not in out  # 旧口径：已改为意图分流
    assert "code_execute=未装配" in out
    assert "package_install=未装配" in out
    assert "terminal=未装配" in out
    assert "browser=未装配" in out
    assert "local_open=未装配" in out
    assert "执行事实" in out
    assert "导入到云" in out
    assert "沙箱不可用" in out or "已是云端会话" in out
    assert "host=已装配" in out
    # 产物出口纠偏：文件在云端、「完整预览」进右坞浏览器；禁止本机「双击打开」
    assert "产物出口" in out
    assert "不在用户本机" in out
    assert "完整预览" in out
    assert "右坞「浏览器」" in out or "右坞" in out
    # 「禁给本机路径 / 禁说双击打开」是收口 HOW，归核的【交付指引】
    assert "双击打开" not in out
    assert "【交付指引】" in hint
    assert "双击打开" in hint and "禁止给本机磁盘路径" in hint
    assert "浏览器事实" in out
    assert "browser=未装配" in out
    assert "host_info" in out or "host_audio" in out or "本机 Host 事实" in out
    # 三分日志只写一遍（核），事实层不再逐 host 分支复述
    assert "三分日志" not in out
    assert hint.count("【三分日志·勿混称】") == 1
    assert "host_os_log_summary" in hint
    # 案 20260803-image-gen-byok-egress-boundary A：云沙箱无任意 HTTPS 出口事实行
    assert "出站网络" in out
    assert "--network=none" in out
    assert "无原生生图工具" in out
    # 「禁代调出图」归核；「Key 不落明文」归共享基座，事实层都不写
    assert "代调" not in out
    assert "API Key" not in out and "明文" not in out
    assert "代调" in hint and "生图" in hint
    # 旧「云端临时空间」短标签已换成诚实草稿口径
    assert "工作区身份：云端临时空间" not in out
    # 约定文档布局（始终可见）：四行出口 + 边界
    assert "约定文档出口·默认落点（无专属出口的产物）：`AgentCore/文档/工作稿/`" in out
    assert "约定文档出口·调研/讨论：`AgentCore/文档/research/`" in out
    assert "约定文档出口·辩论副产物：`AgentCore/文档/debate/`" in out
    assert "约定文档出口·审查：`AgentCore/文档/reviews/`" in out
    assert "讨论/调研/审查类交付写此树" in out
    assert "用户工程源码仍写业务路径" in out
    # 「报路径须完整前缀、禁缩短成裸 reviews/」是 HOW，核的【产物路径】持有
    assert "完整前缀" not in out
    assert "**完整**路径" in hint and "裸 `reviews/…`" in hint
    # FakeBackend has no root → probe unknown; still soft-tips init_baseline (P3).
    assert "init_baseline" in out
    assert "不挡派工" in out or "不挡" in out
    assert "no_repo" in out
    assert "通常无 Git" not in out


def test_cloud_host_off_capability():
    from agentcore.core.types import HostAxis

    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
        host_axis=HostAxis.OFF,
    )
    assert "host=未装配" in out
    assert "host=off" in out or "本机协助" in out or "勿调用 host_*" in out


def test_no_desktop_host_unassembled():
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=False,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    assert "host=未装配" in out
    assert "无桌面回填通道" in out or "勿假装" in out


def test_local_remote_channel_facts():
    out = build_workspace_context(
        _FakeBackend("local", root_label="MyProject", channel=object()),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=True,
        browser_enabled=False,
    )
    assert "执行位置：用户本机（经桌面通道遥控）" in out
    assert "本地目录（根标签 `MyProject`）" in out
    assert "code_execute=已装配" in out
    assert "package_install=已装配" in out
    assert "terminal=已装配" in out
    assert "browser=未装配" in out
    assert "local_open=已装配" in out
    assert "产物出口" in out  # 产物出口事实对本地会话同样注入
    # 本机传统工程：跑当前；换工程优先导入/连 Git，勿再弹 open 建新
    assert "本机传统" in out or "跑" in out
    assert "导入到云" in out or "连接 Git" in out
    assert "open_local_project" in out  # 仍出现于「勿再弹」禁令
    # 桌面分流可教三件套，但不得写成 action= 履约广告句
    assert "action=bind_local_folder" not in out


def test_browser_capability_override():
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=False,
        browser_enabled=True,
    )
    assert "browser=已装配" in out
    assert "local_open=未装配" in out
    # 事实层：谁能直持、宿主是哪种、能不能开相对路径
    assert "CEO 可直持" in out
    assert "仅 worker" in out
    assert "相对" in out or "完整预览" in out
    assert "http(s)" in out or "公网" in out
    # HOW 归核（登录接管 / 禁编造工具名 / 禁 read_url 冒充 / 意图梯度），事实层不复述
    assert "ask_user(browser_login=true)" not in out
    assert "browser_open" not in out
    hint = _CEO_CORE_HINT
    assert "ask_user(browser_login=true)" in hint
    assert "escalate(browser_login=true)" not in hint
    assert "接管" in hint
    assert "browser_navigate" in hint
    assert "**你自己**" in hint
    assert "只用 `read_url` / `web_search` 交差冒充已开页" in hint
    assert "无 browser_open，禁编造未列出的工具名" in hint
    assert "navigate 成功或短操作完成即可" in hint
    assert "验收" in hint and "截图" in hint
    assert "「跑起来 / 打开看一下」≠本条" in hint


def test_local_browser_guide_mentions_workspace_relative_path():
    """甲：本机 + browser 已装配 → 指引相对路径与完整预览同源。"""
    out = build_workspace_context(
        _FakeBackend("local"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=True,
        browser_enabled=True,
    )
    assert "browser=已装配" in out
    assert "site/index.html" in out or "相对" in out
    assert "完整预览" in out or "workspace://" in out
    assert "file://" in out  # 明示不支持
    assert "console" in out  # 能力清单里的 browser_* 之一
    # 「异常先取 JS 错误」是 HOW，归核
    assert "browser_console" in _CEO_CORE_HINT


def test_bridge_session_sandbox_browser_guide_no_relative_html(monkeypatch):
    """过桥：local + 无 Bridge + gVisor → 已装配但沙箱指引（相对路径不可测）。"""
    from agentcore.config import settings
    from agentcore.runtime.browser.desktop_bridge import reset_desktop_bridge_health_for_tests
    from agentcore.tools.sandbox.cloud_health import set_cloud_sandbox_health_for_tests

    reset_desktop_bridge_health_for_tests()
    monkeypatch.setattr(settings, "gvisor_enabled", True)
    set_cloud_sandbox_health_for_tests(True)
    out = build_workspace_context(
        _FakeBackend("local"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=True,
        # 不 override browser_enabled — 走真实闸与 host_kind
    )
    assert "browser=已装配" in out
    assert "云端沙箱浏览器" in out
    assert "相对路径不可测" in out or "完整预览" in out
    assert "Local Bridge 可打开" not in out
    assert "或启用云端沙箱浏览器" not in out


def test_browser_unassembled_guide_mentions_bind_or_gvisor():
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
        browser_enabled=False,
    )
    assert "浏览器事实" in out
    assert "gVisor" in out or "沙箱" in out or "netns" in out
    # 本机传统可教非默认；云协作仍推荐
    assert "本机传统" in out or "合法非默认" in out or "非默认" in out
    assert "bind_local_folder" in out or "open_local_project" in out or "open/bind" in out
    # 禁误导：未装配时勿暗示「本机未装就可随手启用云端沙箱」旧句
    assert "或启用云端沙箱浏览器" not in out
    # 缺能力怎么办只写一遍：核的【能力未装配·统一姿势】管所有能力，事实层不逐条复述
    assert "同轮可开工" not in out
    hint = _CEO_CORE_HINT
    assert hint.count("**【能力未装配·统一姿势】**") == 1
    assert "ask_user(browser_login=true)" in hint
    assert "escalate(browser_login=true)" not in hint
    assert "已登录，继续" in hint
    assert "Cookie" in hint  # 明确否决扫 Cookie 冒充路径
    assert "用浏览器打开" in hint
    assert "非右坞浏览器" in hint
    assert "同轮可开工" in hint
    assert "手脑" in hint
    assert "一等" in hint or "非补救" in hint
    assert "多轮复读" in hint
    assert "补救，但不是" not in hint
    assert "不是接管流程" not in hint


def test_local_browser_unassembled_guide_splits_reason_no_sandbox_teaser():
    """真·本地未装配：拆因；禁「或启用云端沙箱浏览器」误导。"""
    out = build_workspace_context(
        _FakeBackend("local"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=True,
        browser_enabled=False,
    )
    assert "browser=未装配" in out
    assert "无本机 Bridge" in out
    assert "或启用云端沙箱浏览器" not in out
    assert "不可装配" in out
    # 「装配启用条件」是事实，留在这里；「未装配怎么开工」归核，见上一用例
    assert "装配启用需桌面 Local Chromium Bridge 健康" in out
    assert "同轮可开工" not in out


def test_host_mcp_unassembled_states_facts_and_defers_posture_to_core():
    """host/mcp 未装配：事实层只写装没装配与为什么；同轮可开工姿势归核，一处即可。"""
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=False,
        code_execute_enabled=False,
        terminal_enabled=False,
        browser_enabled=False,
    )
    assert "host=未装配" in out
    assert "mcp=未装配" in out
    assert "无桌面回填通道" in out
    assert "同轮可开工" not in out
    hint = _CEO_CORE_HINT
    assert "browser / host / mcp / terminal" in hint  # 统一姿势覆盖各能力
    assert "同轮可开工" in hint
    assert "手脑" in hint
    assert "多轮复读" in hint
    assert "已接 MCP" in hint  # 未装配禁称已用
    assert "把该能力的动作写进给队员的任务" in hint  # 未装配禁派空跑


def test_sidecar_local_without_channel():
    out = build_workspace_context(
        _FakeBackend("local"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=True,
    )
    assert "本机引擎 / sidecar" in out


def test_mobile_session_omits_bind_nudge():
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=False,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    assert "桌面回填通道未连接" in out
    # Must not accuse a device form when the channel is merely offline / fail-closed.
    assert "Web / 移动端" not in out
    assert "Web / 手机" not in out
    assert "当前为 Web" not in out
    assert "通道缺失≠用户在用 Web/手机" in out
    assert "授权仅桌面端可用" in out
    assert "https://fashitianxia.xyz/download" in out
    assert "官方桌面客户端" in out
    assert "勿发 grant_* / bind_local_folder / open_local_project" in out
    # 禁止语里可点名 action；不得写成可履约的 action= 分流广告
    assert "action=bind_local_folder" not in out
    assert "action=grant_readonly_folder" not in out
    assert "action=open_local_project" not in out
    assert "立即发卡" not in out
    assert "与工作区绑定正交" not in out
    assert "授权已确认" in out  # 铁律禁语
    assert "本对话尚无会话级区外目录授权" in out
    assert "本对话已授权区外目录：" not in out  # 无挂载不得声称已授权状态行
    # 案 20260803-cloud-local-root-auth-where A：自称桌面须复检通道；禁「就好办了」/臆造路径
    assert "通道复检铁律" in out
    assert "口述不得覆盖" in out
    assert "就好办了" in out
    assert "打开【本对话】" in out or "打开本对话" in out
    assert "状态栏" in out
    assert "导入到云" in out or "连接 Git" in out or "Composer" in out
    assert "Folders" in out  # 禁语点名非真源
    assert "臆造" in out


def test_channel_offline_self_claim_desktop_recheck_honesty():
    """案 A：通道未接时 workspace_context 须钉死口述复检 + b0a9 步骤 + 禁臆造入口。"""
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=False,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    assert "host=未装配" in out
    assert "local_open=未装配" in out
    assert "通道复检铁律" in out
    assert "正在用客户端" in out or "已装桌面" in out
    assert "口述不得覆盖" in out
    assert "就好办了" in out
    assert "桌面就好办" in out
    assert "①" in out and "②" in out and "③" in out and "④" in out
    assert "https://fashitianxia.xyz/download" in out
    assert "导入到云" in out or "连接 Git" in out or "Composer" in out
    assert "Folders" in out
    assert "设置→Folders" in out or "侧栏授权页" in out
    # 「用户问授权在哪里」的触发语删了；被问时要复述的固定步骤与真源入口仍在同一行
    assert "复述固定步骤" in out
    assert "只指真源入口名" in out
    # 不得在离线分支广告可履约发卡
    assert "立即发卡" not in out
    assert "action=open_local_project" not in out


def test_no_mounts_forbids_claiming_grant_confirmed():
    """未见 external 挂载行时，prompt 须禁止「授权已确认」。"""
    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=False,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    assert "本对话尚无会话级区外目录授权" in out
    assert "本对话已授权区外目录：" not in out
    assert "禁止声称授权已确认" in out
    # 铁律只在 mounts 行落一次（离线 grant 行不再抄一遍）
    assert out.count("授权已确认") == 1


def test_cloud_desktop_online_allows_external_grant_without_bind():
    """W3 正交：云端 scratch + 桌面在线 → 可直接只读静默挂载，勿要求先 bind。"""
    out = build_workspace_context(
        _FakeBackend("server", root_label="conv:x"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    assert "执行位置：云端沙箱" in out
    assert "external_mount_readonly" in out
    assert "与工作区绑定正交" in out
    assert "本机某目录" in out
    assert "区外目录授权需先处在本地工作区" not in out
    assert "选择器兜底" not in out
    # 怎么定位目录（禁手填绝对路径 / 禁探家目录 / 只读禁再发卡）归核
    hint = _CEO_CORE_HINT
    assert "手填绝对路径" in hint and "探主机家目录" in hint
    assert "为只读新发 `grant_readonly_folder`" in hint
    assert "grant_readonly_folder" not in out


def test_assemble_system_prompt_includes_workspace_facts():
    facts = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    prompt = assemble_system_prompt(workspace_context=facts)
    assert "<workspace_context>" in prompt
    assert "云端沙箱" in prompt
    # Without facts, no block (prefix-cache identity for catalog / bare tests).
    bare = assemble_system_prompt()
    assert "<workspace_context>" not in bare


def test_git_fact_present_line_no_soft_init_tip(tmp_path):
    from agentcore.runtime.context.workspace_context import (
        detect_workspace_git_sync,
    )
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox
    from agentcore.workspace.server import ServerWorkspace

    root = tmp_path / "repo"
    root.mkdir()
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    backend = ServerWorkspace(root=root, sandbox=SubprocessSandbox())
    fact = detect_workspace_git_sync(backend)
    assert fact.present is True
    assert fact.branch == "main"
    out = build_workspace_context(
        backend,
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
        git_fact=fact,
    )
    assert "版本控制：Git" in out
    assert "分支 `main`" in out
    assert "init_baseline" not in out


def test_git_absent_soft_tip_visible_with_explicit_fact():
    from agentcore.runtime.context.workspace_context import WorkspaceGitFact

    out = build_workspace_context(
        _FakeBackend("local"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
        git_fact=WorkspaceGitFact(present=False),
    )
    assert "工作区根无 Git" in out
    assert "init_baseline" in out
    assert "不挡派工" in out


def test_git_absent_soft_tip_does_not_change_should_kickoff():
    """P3: no-git soft tip must not flip kickoff / durable-pause truth."""
    from agentcore.core.types import (
        CommandAxis,
        FileWriteAxis,
        HostAxis,
        PermissionAxes,
        TeamKickoffAxis,
    )
    from agentcore.runtime.context.workspace_context import WorkspaceGitFact
    from agentcore.runtime.kickoff.gate import should_kickoff

    out = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
        git_fact=WorkspaceGitFact(present=False),
    )
    assert "工作区根无 Git" in out
    assert "init_baseline" in out

    axes = PermissionAxes(
        FileWriteAxis.SESSION,
        CommandAxis.KICKOFF,
        TeamKickoffAxis.RULES,
        HostAxis.ASK,
    )
    # Same inputs as a normal multi-worker plan-preview kickoff — git tip is orthogonal.
    assert should_kickoff(plan_preview=True, local_gate=True, axes=axes) is True
    assert should_kickoff(plan_preview=False, local_gate=False, axes=axes) is False


def test_cloud_package_install_tracks_registry_egress(monkeypatch):
    """云端：code_execute 已装配仍可 package_install=未装配（egress 假）；egress 真则拆位翻开。"""
    out_off = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=False,
        package_install_enabled=False,
    )
    assert "code_execute=已装配" in out_off
    assert "package_install=未装配" in out_off
    assert "能跑代码 ≠ 能装依赖" in out_off or "registry_egress" in out_off

    out_on = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=False,
        package_install_enabled=True,
    )
    assert "code_execute=已装配" in out_on
    assert "package_install=已装配" in out_on
    assert "allowlist egress" in out_on or "netns" in out_on

    monkeypatch.setattr(
        "agentcore.tools.sandbox.egress.registry_egress_available",
        lambda: False,
    )
    out_probe_off = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=False,
    )
    assert "package_install=未装配" in out_probe_off

    monkeypatch.setattr(
        "agentcore.tools.sandbox.egress.registry_egress_available",
        lambda: True,
    )
    out_probe_on = build_workspace_context(
        _FakeBackend("server"),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=False,
    )
    assert "package_install=已装配" in out_probe_on


def test_local_package_install_follows_execution_class():
    """本机：装依赖跟执行类，不吃主机 registry_egress。"""
    out = build_workspace_context(
        _FakeBackend("local", root_label="MyProject", channel=object()),
        desktop_online=True,
        code_execute_enabled=True,
        terminal_enabled=True,
        browser_enabled=False,
    )
    assert "code_execute=已装配" in out
    assert "package_install=已装配" in out
    assert "不吃主机 registry_egress" in out

    out_off = build_workspace_context(
        _FakeBackend("local"),
        desktop_online=True,
        code_execute_enabled=False,
        terminal_enabled=False,
    )
    assert "package_install=未装配" in out_off


def test_env_examples_gvisor_timeout_does_not_clamp_outer_verify():
    """样例 GVISOR_TIMEOUT_MAX_SECONDS 勿钉 60（会夹死外环灾难顶 1200s）。"""
    from pathlib import Path

    roots = [
        Path(__file__).resolve().parents[3] / "deploy" / "config" / "production.env.example",
        Path(__file__).resolve().parents[1] / ".env.example",
    ]
    for path in roots:
        text = path.read_text(encoding="utf-8")
        assert "GVISOR_TIMEOUT_MAX_SECONDS=60" not in text
        assert "GVISOR_TIMEOUT_MAX_SECONDS=1230" in text
        assert "夹死" in text or "外环" in text
