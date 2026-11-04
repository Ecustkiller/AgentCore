"""Skill Pack：纯 markdown 的导入 / 导出包 (生成 / 最后修订 2026-11-04).

⚠️ 与上游口径的边界：文档明确「**只卖 Skill**」「技能包内嵌脚本 / 新工具当
SKU **否决**」「包内塞脚本仍否决」「装进去的是教法，不卖新工具」。所以这里
**不是插件包**：zip 里只准有 ``SKILL.md`` 与 ``references/*.md``，任何
``.py/.sh/.js/.json``、可执行文件、manifest、工具声明一律整包拒绝；
没有依赖安装、没有 hooks / tools 贡献点、没有签名 / semver。

技能在本仓库是一条 ``role=rule`` / ``apply_mode=on_demand`` 的 Document 行，
不是目录；包只是这条行的**可搬走表示**。导入仍走 ``DocumentRepository.create``
这条唯一写路径，导出只是把它序列化回一个 zip。

安全：复用 ``storage/_archive.py::iter_zip_file_members`` 的 zip-slip 与
zip-bomb 闸门（按**实际解压字节**计数，不信 ``file_size``）；本模块从不落盘，
只读进内存。声明里写了 ``apply: always`` 之类的意图时**整包拒绝**，不静默
降级成按需 —— 与 ``frontmatter.py`` 的「stated intent 不得悄悄改写」同口径。
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass

from agentcore.documents.frontmatter import set_entry_frontmatter
from agentcore.storage._archive import (
    ZipExtractLimitError,
    ZipSlipError,
    iter_zip_file_members,
)

PACK_ENTRY = "SKILL.md"
MAX_PACK_FILES = 8
MAX_PACK_BYTES = 256 * 1024
MAX_SKILL_NAME = 120
MAX_DESCRIPTION = 500
MAX_BODY_BYTES = 200 * 1024
MAX_FRONTMATTER_LINES = 40
_ALLOWED_KEYS = frozenset({"name", "description", "apply"})
_NAME_RE = re.compile(
    r"^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9._\- \u4e00-\u9fff]{0,119}$"
)
_REF_RE = re.compile(r"^references/([A-Za-z0-9][A-Za-z0-9._\-]{0,79})\.md$")
_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class SkillPackError(ValueError):
    """包不合法；文案可直接回给用户（不含路径 / 密钥）。"""


@dataclass(frozen=True, slots=True)
class SkillPack:
    name: str
    description: str
    body: str
    references: tuple[tuple[str, str], ...] = ()


def _check_text(*, name: str, description: str, body: str) -> None:
    if not _NAME_RE.fullmatch(name):
        raise SkillPackError("技能名不合法（只允许中英文、数字、空格、. _ -，且 ≤120 字）")
    if not description or len(description) > MAX_DESCRIPTION:
        raise SkillPackError("description 不能为空且不得超过 500 字")
    if not body.strip():
        raise SkillPackError("技能正文不能为空")
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise SkillPackError("技能正文过大")
    if _CONTROL_RE.search(name) or _CONTROL_RE.search(description):
        raise SkillPackError("技能名 / 描述含控制字符")


def build_pack(
    *,
    name: str,
    description: str,
    body: str,
    references: tuple[tuple[str, str], ...] = (),
) -> bytes:
    """导出：一个 zip，根 ``SKILL.md`` + 可选 ``references/*.md``。"""
    _check_text(name=name, description=description, body=body)
    if len(references) + 1 > MAX_PACK_FILES:
        raise SkillPackError("包内文件过多")
    seen: set[str] = set()
    for rel, text in references:
        if not _REF_RE.fullmatch(rel) or rel in seen:
            raise SkillPackError("只允许 references/*.md 参考文件")
        seen.add(rel)
        if len(text.encode("utf-8")) > MAX_BODY_BYTES:
            raise SkillPackError("参考文件过大")
    skill_md = (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        "apply: on_demand\n"
        "---\n\n"
        f"{body.strip()}\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(PACK_ENTRY, skill_md.encode("utf-8"))
        for rel, text in references:
            zf.writestr(rel, text.encode("utf-8"))
    return buf.getvalue()


def _parse_skill_md(text: str) -> tuple[str, str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillPackError("SKILL.md 缺少 frontmatter 起始 ---")
    close = -1
    for idx in range(1, min(len(lines), MAX_FRONTMATTER_LINES + 1)):
        if lines[idx].strip() == "---":
            close = idx
            break
    if close < 0:
        raise SkillPackError("SKILL.md frontmatter 未闭合")
    fields: dict[str, str] = {}
    for line in lines[1:close]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _KEY_RE.match(stripped)
        if match is None or match.group(1).lower() not in _ALLOWED_KEYS:
            raise SkillPackError("SKILL.md 含不支持的 frontmatter 键")
        key = match.group(1).lower()
        if key in fields:
            raise SkillPackError("SKILL.md frontmatter 键重复")
        fields[key] = match.group(2).strip().strip('"').strip("'")
    if fields.get("apply", "on_demand").lower() != "on_demand":
        # 声明了 always / paths 就想静默改按需 = 悄悄改写作者意图，拒绝。
        raise SkillPackError("技能包必须声明 apply: on_demand")
    name = fields.get("name", "")
    description = fields.get("description", "")
    body = "\n".join(lines[close + 1 :]).strip()
    _check_text(name=name, description=description, body=body)
    return name, description, body


def parse_pack(data: bytes) -> SkillPack:
    """导入：校验整包，返回纯数据；调用方负责写库。"""
    if not isinstance(data, bytes) or not data:
        raise SkillPackError("技能包为空")
    if len(data) > MAX_PACK_BYTES:
        raise SkillPackError("技能包过大")
    try:
        members = iter_zip_file_members(
            data,
            max_files=MAX_PACK_FILES,
            max_uncompressed_bytes=MAX_PACK_BYTES,
        )
    except (zipfile.BadZipFile, ZipSlipError, ZipExtractLimitError, OSError, ValueError) as exc:
        raise SkillPackError("技能包不是合法的 zip 或超出安全限制") from exc
    if not members:
        raise SkillPackError("技能包为空")
    skill_md: str | None = None
    references: list[tuple[str, str]] = []
    for rel, raw in members:
        if rel != PACK_ENTRY and not _REF_RE.fullmatch(rel):
            raise SkillPackError("技能包只准包含 SKILL.md 与 references/*.md")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SkillPackError("技能包内文件不是 UTF-8") from exc
        if rel == PACK_ENTRY:
            if skill_md is not None:
                raise SkillPackError("技能包含多个 SKILL.md")
            skill_md = text
        else:
            references.append((rel, text))
    if skill_md is None:
        raise SkillPackError("技能包缺少 SKILL.md")
    name, description, body = _parse_skill_md(skill_md)
    return SkillPack(
        name=name,
        description=description,
        body=body,
        references=tuple(sorted(references)),
    )


def canonical_content(pack: SkillPack) -> str:
    """转成仓库唯一认得的 Document 正文（frontmatter 由 frontmatter.py 写）。"""
    return set_entry_frontmatter(
        pack.body, apply="on_demand", description=pack.description
    )
