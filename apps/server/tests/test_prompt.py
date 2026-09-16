"""Tests for system-prompt assembly (`assemble_system_prompt`) and the slim CEO core.

Pins structure only (上下文工程 · 测试守卫原则): XML tags, English tool/field/skill
names, consult pointers, fences, assembly order, date granularity, one-layer-one-place.
Does not pin teaching Chinese. Skill HOW bodies belong in ``test_skills.py``;
this file only asserts those identifiers are absent from the core / compose opening.

The CEO core is identity tags — not a numbered routing classifier. Honesty / output /
inbound trust live in the shared base. HOW lives in system Skills / tool descriptions.
"""

import json
import re

from agentcore.runtime.context.consultable import ConsultDirectoryEntry
from agentcore.runtime.resolve.prompt import (
    _ATTACHMENT_MATERIAL_HINT,
    _CEO_CORE_HINT,
    _DEFAULT_SYSTEM_PROMPT,
    assemble_ceo_core,
    assemble_system_prompt,
    attachment_material_scene,
    capability_how_suffix,
    compose_ceo_chat_prompt,
    compose_worker_base_prompt,
    derive_ceo_addon,
)
from agentcore.runtime.resolve.prompt.compose import _on_demand_preamble
from agentcore.runtime.resolve.prompt.memory_rules import _RULES_ROUTING_FENCE
from agentcore.runtime.skills import (
    _DELIVERY,
    _LOCAL_DESK,
    _STAFFING,
    build_system_skill_registry,
    render_skill_directory,
)
from agentcore.runtime.skills.registry import AUDIENCE_WORKER
from agentcore.runtime.skills.run import _RUN
from agentcore.tools.builtin.delegate.schema import (
    DELEGATE_DESCRIPTION,
    DELEGATE_PARAMETERS,
    DELEGATE_WHEN,
    NESTED_DELEGATE_DESCRIPTION,
)
from agentcore.tools.builtin.run import run_description

_TASK_PROPS = DELEGATE_PARAMETERS["properties"]["tasks"]["items"]["properties"]
_HANDBOOK_SIGNATURES = (
    "wait_for",
    "ask_user(browser_login=true)",
    "host(action=os_log)",
    "host(action=status)",
    "host(action=shell)",
)


def _compose_ceo(tool_names: set[str], **kwargs) -> str:
    return compose_ceo_chat_prompt(
        assemble_system_prompt(),
        skill_registry=build_system_skill_registry(),
        ceo_tool_names=tool_names,
        **kwargs,
    )


def test_derive_ceo_addon_splits_shared_prefix_from_full_ceo_prompt():
    base = assemble_system_prompt()
    ceo = _compose_ceo({"delegate", "consult", "ask_user"})
    addon = derive_ceo_addon(base, ceo)
    assert addon
    assert "<文件夹清单>" not in ceo
    assert "<身份>" in addon
    assert "<输出>" not in addon
    assert ceo.startswith(base)
    assert addon == ceo[len(base) :].lstrip("\n")
    assert ceo == base + ceo[len(base) :]


def test_shared_base_xml_tags():
    out = assemble_system_prompt()
    for tag in ("输出", "输入", "诚实", "工作权威", "运行时"):
        assert f"<{tag}>" in out and f"</{tag}>" in out
    assert "<身份>" not in out
    assert "</工作区>" not in out
    assert _DEFAULT_SYSTEM_PROMPT.count("<输出>") == 1
    assert _DEFAULT_SYSTEM_PROMPT.count("<诚实>") == 1


def test_output_english_affordances():
    style = assemble_system_prompt().split("<输出>", 1)[1].split("</输出>", 1)[0]
    assert "emoji" in style
    assert "Markdown" in style
    assert "LaTeX" in style
    assert "mermaid" in style


def test_inbound_tags_fences_and_system_prompt_marker():
    base = assemble_system_prompt()
    assert "<输入>" in base and "</输入>" in base
    inbound = base.split("<输入>", 1)[1].split("</输入>", 1)[0]
    assert "【数据】" in inbound
    assert "[系统提示]" in inbound
    ceo = _compose_ceo({"delegate", "consult"})
    assert "<输入>" in ceo
    assert "[系统提示]" in ceo
    assert "【数据】" in ceo


def test_web_search_not_restated_in_base_tooling():
    out = assemble_system_prompt()
    tool = out.split("<输出>", 1)[0]
    honesty = out.split("<诚实>", 1)[1].split("</诚实>", 1)[0]
    assert "web_search" not in tool
    assert "#rN" in honesty


def test_runtime_context_uses_date_granularity_for_cache_stability():
    # The runtime-context line sits in the system-prompt prefix BEFORE the large
    # stable hint stack, so it must NOT carry second-precision time: a value that
    # changed every turn broke DeepSeek's exact-prefix cache for everything after it
    # (the whole CEO hint stack got re-billed each turn). Pin date granularity + the
    # call-to-call stability that makes the stable core cacheable within a day, so a
    # refactor can't silently reintroduce the cache-buster.
    out = assemble_system_prompt()
    assert re.search(r"当前日期：\d{4}-\d{2}-\d{2}", out)
    assert not re.search(r"\d{2}:\d{2}:\d{2}", out)  # no HH:MM:SS timestamp
    assert assemble_system_prompt() == out  # byte-identical across calls (same day)


def test_output_style_survives_memory_and_context_layers():
    out = assemble_system_prompt(
        rules_markdown="- 用户偏好简洁回复",
        extra_context="<附件>...</附件>",
    )
    assert "<输出>" in out
    assert "用户偏好简洁回复" in out
    assert "<附件>" in out
    assert "<设定>" in out and "</设定>" in out
    assert _RULES_ROUTING_FENCE in out


def test_style_precedes_ceo_only_core_when_composed():
    base = assemble_system_prompt()
    ceo = _compose_ceo({"delegate", "consult"})
    assert "<输出>" in base
    assert "<输出>" not in _CEO_CORE_HINT
    assert ceo.find("<输出>") < ceo.find("<运行时>") < ceo.find("<身份>")
    assert ceo.find("<身份>") < ceo.find("<按需目录>")


def test_capability_how_gated_on_ceo_tool_names():
    """本机/Host/浏览器 HOW 唯一所有者 = consult；冻结核与 compose 开场都不挂手册。"""
    spine = _CEO_CORE_HINT
    for sig in _HANDBOOK_SIGNATURES:
        assert sig not in spine
    assert capability_how_suffix({"run"}) == ""
    assert capability_how_suffix({"external_mount_readonly"}) == ""
    run_how = capability_how_suffix({"run"})
    host = capability_how_suffix({"host"})
    browser = capability_how_suffix({"browser"})
    assert host.strip() and browser.strip()
    assert "wait_for" not in run_how
    assert "ask_user(browser_login=true)" not in run_how
    assert "wait_for" not in host
    assert "wait_for" not in browser
    assert "wait_for" not in _LOCAL_DESK
    assert "delegate" not in host

    for names, offered in (
        ({"delegate", "consult"}, None),
        ({"delegate", "run", "host", "browser"}, None),
        (
            {"delegate", "run", "host", "browser"},
            {"delegate", "run", "host", "browser"},
        ),
        ({"delegate", "run", "host", "browser"}, {"delegate"}),
    ):
        prompt = compose_ceo_chat_prompt(
            assemble_system_prompt(),
            ceo_tool_names=names,
            **({"ceo_offered_names": offered} if offered is not None else {}),
        )
        for sig in _HANDBOOK_SIGNATURES:
            assert sig not in prompt
        assert assemble_ceo_core(names) == spine


def test_how_consult_pointer_has_handbook_body():
    """HOW→consult(name) 必须能拉到手册：系统 Skill，或 capability_how_suffix 有正文。"""
    from agentcore.tools.registration import declared_tool_schema, declared_tools

    skills = {s.name for s in build_system_skill_registry().list_all()}
    blobs: list[tuple[str, str]] = [("delegate.nested", NESTED_DELEGATE_DESCRIPTION)]
    for cls in declared_tools():
        schema = declared_tool_schema(cls)
        blob = schema.description + json.dumps(schema.parameters, ensure_ascii=False)
        blobs.append((schema.name, blob))
    empty: list[str] = []
    for tool_name, blob in blobs:
        targets = re.findall(r"HOW→consult\((\w+)\)", blob)
        if targets:
            targets.extend(re.findall(r"、consult\((\w+)\)", blob))
        for target in targets:
            if target in skills or capability_how_suffix({target}).strip():
                continue
            empty.append(f"{tool_name}→{target}")
    assert not empty, f"HOW→consult 指向没有手册的键：{empty}"


def test_consult_hook_lives_only_in_the_core():
    """consult 钩在按需目录 / consult description；场面 HOW 在 skill 正文；目录只写这是什么。"""
    directory = render_skill_directory(
        build_system_skill_registry(),
        {"delegate", "consult", "ask_user", "debate"},
    )
    hint = _CEO_CORE_HINT
    ceo = _compose_ceo({"delegate", "consult", "ask_user", "debate"})
    preamble = "\n".join(_on_demand_preamble(with_summaries=True))
    assert "consult(name)" not in hint
    assert "<按需目录>" not in hint
    assert "consult(name)" in ceo
    assert "consult(name)" in preamble
    assert "<按需目录>" in preamble and "</按需目录>" not in preamble
    assert ceo.count("<按需目录>") == 1 and ceo.count("</按需目录>") == 1
    assert "staffing" in directory
    assert "lead_subteam" not in ceo
    assert "debate_and_review" in directory
    assert "debate_and_review" in ceo
    assert "HOW→consult" not in hint


def test_delegate_schema_keys_one_layer():
    hint = _CEO_CORE_HINT
    props = DELEGATE_PARAMETERS["properties"]
    assert "depends_on" in _TASK_PROPS
    assert "target_folder_id" in _TASK_PROPS
    assert "append_to_execution_id" in props
    assert "playbook" in props
    for key in (
        "depends_on",
        "target_folder_id",
        "append_to_execution_id",
        "playbook",
    ):
        assert key not in hint
        assert key not in _STAFFING


def test_how_identifiers_not_in_resident_core():
    hint = _CEO_CORE_HINT
    for sig in _HANDBOOK_SIGNATURES:
        assert sig not in hint
    for key in (
        "file_copy",
        "create_folder",
        "md_export",
        "consult(name)",
        "consult(browser)",
        "HOW→consult",
        "delegate",
        "debate_and_review",
        ".mdc",
        "Cursor",
    ):
        assert key not in hint
    assert "create_folder" not in _DELIVERY
    for fence in (
        "【本轮材料收窄】",
        "【已确认约束】",
        "【执行 / 运行 / 打开】",
        "【产物路径】",
        "【落盘前对齐】",
        "【成品文件只装成品】",
        "【对人说】",
    ):
        assert fence not in hint
    assert "【对人说】" not in _DEFAULT_SYSTEM_PROMPT
    assert _RULES_ROUTING_FENCE not in hint
    role = hint.split("<身份>", 1)[1].split("</身份>", 1)[0]
    assert "delegate" not in role
    assert "Cursor" not in role
    assert ".mdc" not in role


def test_delegate_when_is_shared_window_bound():
    """根 / 嵌套 delegate 共用 when-to-use 核；HOW→consult 分叉到各自手册。"""
    assert DELEGATE_WHEN in DELEGATE_DESCRIPTION
    assert DELEGATE_WHEN in NESTED_DELEGATE_DESCRIPTION
    assert "HOW→consult(staffing)" in DELEGATE_DESCRIPTION
    assert "HOW→consult(staffing)" not in NESTED_DELEGATE_DESCRIPTION
    assert "HOW→consult(lead_subteam)" in NESTED_DELEGATE_DESCRIPTION
    assert "HOW→consult(lead_subteam)" not in DELEGATE_DESCRIPTION


def test_work_authority_does_not_host_tool_when_to_use():
    shared = _DEFAULT_SYSTEM_PROMPT
    assert "<工作权威>" in shared and "</工作权威>" in shared
    assert "AGENTS.md" in shared
    assert "escalate" not in shared
    assert "ask_user" not in shared
    worker = compose_worker_base_prompt(assemble_system_prompt())
    ceo = _compose_ceo({"delegate", "consult", "ask_user"})
    assert worker.count("<诚实>") == 1
    assert ceo.count("<诚实>") == 1
    assert ceo.count("<身份>") == 1
    assert "<身份>" not in worker


def test_worker_opening_drops_ceo_orchestration_context():
    """叶子开场不含主管编制手册；嵌套 lead 仅多 ``lead_subteam``（持 delegate 才进目录）。"""
    base = assemble_system_prompt()
    worker_bare = compose_worker_base_prompt(base)
    assert "staffing" not in worker_bare
    assert "lead_subteam" not in worker_bare

    reg = build_system_skill_registry()
    leaf_names = {s.name for s in reg.available(set(), audience=AUDIENCE_WORKER)}
    lead_names = {s.name for s in reg.available({"delegate"}, audience=AUDIENCE_WORKER)}
    assert leaf_names == {"data_file_landing", "page_ui"}
    assert lead_names == {"data_file_landing", "lead_subteam", "page_ui"}
    worker_dir = compose_worker_base_prompt(
        base,
        on_demand_entries=[
            ConsultDirectoryEntry(name=s.name, summary=s.summary)
            for s in reg.available(set(), audience=AUDIENCE_WORKER)
        ],
    )
    assert "page_ui" in worker_dir
    assert "data_file_landing" in worker_dir
    assert "staffing" not in worker_dir
    assert "lead_subteam" not in worker_dir
    assert "delivery" not in worker_dir
    assert "local_desk" not in worker_dir
    lead_dir = compose_worker_base_prompt(
        base,
        on_demand_entries=[
            ConsultDirectoryEntry(name=s.name, summary=s.summary)
            for s in reg.available({"delegate"}, audience=AUDIENCE_WORKER)
        ],
    )
    assert "lead_subteam" in lead_dir
    assert "staffing" not in lead_dir


def test_run_skill_does_not_ban_curl():
    """公网门是改道，不是禁止句。"""
    for hay in (_RUN, run_description("server"), run_description("local")):
        assert "不要用 curl" not in hay
        assert "禁止用 curl" not in hay


def test_core_teaches_narrowed_attachment_scope_must_start():
    # 定案 A：场面门（同构 cold_start）：常驻核不载全文，仅本回合有附件块 /
    # [resident missing] 时注入。
    hint = _CEO_CORE_HINT
    assert "【本轮材料收窄】" not in hint
    gated = _ATTACHMENT_MATERIAL_HINT
    assert "<本轮材料>" in gated and "</本轮材料>" in gated
    assert "【本轮材料收窄】" in gated
    assert "[resident missing]" in gated

    names = {"consult", "delegate", "ask_user"}
    without = compose_ceo_chat_prompt(
        "BASE",
        ceo_tool_names=names,
        attachment_material=False,
    )
    with_flag = compose_ceo_chat_prompt(
        "BASE",
        ceo_tool_names=names,
        attachment_material=True,
    )
    assert "<本轮材料>" not in without
    assert "<本轮材料>" in with_flag
    assert "【本轮材料收窄】" in with_flag
    assert "[resident missing]" in with_flag
    assert attachment_material_scene("<附件>\nfoo\n</附件>") is True
    assert attachment_material_scene("--- File: a.zip [resident missing] ---") is True
    assert attachment_material_scene(None) is False
    assert attachment_material_scene("") is False
    assert attachment_material_scene("<队员点名/>") is False
    assert attachment_material_scene("<钉住条目>\n设定\n</钉住条目>") is False
