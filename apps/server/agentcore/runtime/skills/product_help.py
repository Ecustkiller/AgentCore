"""Skill body: product_help.

Catalog summary is what this is; HOW + index live in the consult body.
Section facts are the desktop manual corpus; fetch with consult("product_help:<id>").
Identity one-liner lives in CEO ``<身份>``.
上报入口与「看不到服务端日志」跟用法同一 WHEN，不另立排查 skill。
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

PRODUCT_HELP_NAME = "product_help"
PRODUCT_HELP_SECTION_SEP = ":"

_CORPUS_PATH = Path(__file__).with_name("product_help_corpus.json")
_SURFACE_ZH = {"desktop": "桌面", "web": "网页", "mobile": "手机"}
_ALL_SURFACES = ("desktop", "web", "mobile")

_PRODUCT_HELP_HOW = """\
<本产品用法>
用户问本产品怎么用 / 是什么 / 入口 / 官网 / 下载 / FAQ / 自主度 / 市场 / 协作桌 / 文件怎么拿走 / 分享时，\
身份与网址用本卡【这是什么】【官网】短答；点名功能再 consult("product_help:<节id>") 用该节短答。\
勿整节粘贴、勿向量 RAG。禁内部名（ask_user / SSE / playbook / run）出口；用产品面说法（对话、协作图、工作区、检查点、审批）。\
身份问（「这是什么项目 / 你是什么」）：可见正文**首句**用【这是什么】（consult 不能代替作答）。\
点名官网 / 你的网站 / 下载才给【官网】三条。

【这是什么】（intro·what）
身份问时本段即用户可见首句，先答再谈别的。\
AgentCore 是 Multi-Agent AI 工作台：你只对接一位 CEO；简单问题直接答，复杂任务组团协作后把结果交给你。\
「协作，是更高级的智能」。例：`#/toolbox/manual/intro?s=what`

【官网】
若要给官网 / 下载地址，只用下面三条。
本产品官网：https://fashitianxia.xyz
桌面安装包：https://fashitianxia.xyz/download
网页版：https://app.fashitianxia.xyz

【怎么答】
短答。桌面可附手册链接 `#/toolbox/manual/{章}?s={节}`——章=`intro|collaboration|mechanism|reference`。\
手机无产品手册（窄屏不上工具箱）：只短答，勿承诺「点链接打开手册」或可点手册链接。\
页名也按端写（勿套桌面名）：桌面「设置 · 服务商」/「设置 · 模型组合」/「设置 · 用量」；\
手机 ☰ 打开侧栏进「设置」再点「服务商」、再点「模型组合」、再点「用量」（两端同树，无底栏 tab）。\
某入口手机没有对应页 → 写「手机无此入口」或真实替代路径，禁止编一个手机页名。\
节回执若写可用性缺当前端，先说无此入口再给替代。选读节（目录「选读」）仅当用户问协作图 / 机制时再拉。

【收口】产物出口：对照 `<工作区>`「执行」——本机可给真实路径；云端文件不在用户电脑，禁止给本机磁盘路径、禁止称文件已在用户电脑上、禁止说「双击打开」。\
细节 consult("product_help:workspace")。对用户指路【禁止】说「工作区根 / 工作区根目录」——用面板上的文件夹名 / 文件名。\
HTML「完整预览」仅桌面；Web / 手机走文件面板下载。

【记忆/历史·对人怎么说】用户问「能不能读历史对话 / 有没有记忆 / 记忆怎么工作」：白话三层见 consult("product_help:memory")——\
当前这场对话；你写过的规矩；过往事情可查旧对话。\
禁止报工具名与内部角色名（`consult` / `delegate` / 查阅员 / 日志工具）。\
结尾说明可以去查旧场、可问要不要现在找——勿停在「不能 / 不知道」。跨会话原文短查询自己做；成规模派工走 `delegate`。\
【用户规则·内部】用户规则可写、可读、可删、可列；改一篇须 `remember`（action=write 覆盖该文件名），删须 action=delete。\
用户规则进 `<设定>` 平权注入。画像/主题不进设定、不靠 `consult`。\
【用户规则·对人怎么说】用户规则可写、可改、可删。对外说话跟工具返回一致；禁止报内部参数名堆砌，可用「已写入… / 已删掉… / 当前规则是…」。\
用户问「你能改规则吗」：能，说明可记/改/删；大段手改也可去文件页规则本。\
Cursor `.cursor/rules` / `.mdc` ≠ AgentCore 用户规则；\
AgentCore 用户规则 = `AgentCore/规则/` + `remember`；`skills/*.json` = 技能/能力包，**不是**「平台规则」迁移目标。\
用户说把 Cursor 规则改成 AgentCore 规则 → 用本条；\
未钉死目标载体前禁止默认迁成 skill JSON；consult 后至多一次窄 list `.cursor/rules`，\
仍不清 → `ask_user`；禁多轮 list / 通读 `.mdc` 再问。

【上报】看不到服务端日志，勿假装读了。对人短答走 consult("product_help:troubleshooting")（消息页内测群 / 官网公示 https://fashitianxia.xyz）。勿改产品仓 / 开 PR。
"""


@cache
def load_product_help_corpus() -> dict[str, Any]:
    return json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))


def _sections() -> list[dict[str, Any]]:
    return list(load_product_help_corpus()["sections"])


def _aliases() -> dict[str, str]:
    raw = load_product_help_corpus().get("aliases") or {}
    return {str(k): str(v) for k, v in raw.items()}


def resolve_product_help_section_id(section_id: str) -> str:
    key = section_id.strip()
    return _aliases().get(key, key)


def list_product_help_section_ids() -> list[str]:
    return [str(s["id"]) for s in _sections()]


def _toc_lines() -> str:
    default_rows: list[str] = []
    optional_rows: list[str] = []
    for sec in _sections():
        row = f"- {sec['id']} — {sec['title']}"
        if sec.get("ai") == "optional":
            optional_rows.append(row)
        else:
            default_rows.append(row)
    parts = [
        "【节目录】点名功能再 consult(\"product_help:<id>\")；勿把没点的节打进来。",
        "默认：",
        *default_rows,
    ]
    if optional_rows:
        parts.extend(["选读（宽问「怎么用」不要拉）：", *optional_rows])
    return "\n".join(parts)


def build_product_help_body() -> str:
    how = _PRODUCT_HELP_HOW.rstrip()
    return f"{how}\n\n{_toc_lines()}\n</本产品用法>"


def _availability_line(availability: list[str]) -> str:
    present = [s for s in _ALL_SURFACES if s in availability]
    missing = [s for s in _ALL_SURFACES if s not in availability]
    if not missing:
        return ""
    yes = "、".join(_SURFACE_ZH[s] for s in present)
    no = "、".join(_SURFACE_ZH[s] for s in missing)
    return f"【可用性】{yes}；{no}无此入口。\n"


def format_product_help_section(sec: dict[str, Any]) -> str:
    avail = [str(x) for x in sec.get("availability") or list(_ALL_SURFACES)]
    bits = [f"# {sec['title']}", ""]
    line = _availability_line(avail)
    if line:
        bits.append(line)
    bits.append(str(sec.get("text") or "").strip())
    href = str(sec.get("href") or "").strip()
    if href:
        bits.extend(["", f"桌面手册：`{href}`"])
    return "\n".join(bits).strip() + "\n"


def fetch_product_help_section(section_id: str) -> str:
    """Return section body or a soft-miss listing valid ids (never None)."""
    raw = section_id.strip()
    if not raw:
        ids = "、".join(list_product_help_section_ids())
        return f"缺少节 id。可查阅：{ids}。"
    canonical = resolve_product_help_section_id(raw)
    for sec in _sections():
        if str(sec["id"]) == canonical:
            return format_product_help_section(sec)
    ids = "、".join(list_product_help_section_ids())
    return f"没有名为 '{raw}' 的手册节。可查阅：{ids}。"
