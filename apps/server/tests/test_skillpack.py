"""Skill Pack 包格式与安全闸门（生成 / 最后修订 2026-11-04）。

上游否决「技能包内嵌脚本 / 新工具当 SKU」，所以这里的测试重点不是
「能不能打包」，而是「任何代码 / manifest / 越界路径都必须整包拒绝」。
"""

from __future__ import annotations

import io
import zipfile

import pytest

from agentcore.documents.frontmatter import parse_entry_frontmatter
from agentcore.documents.skillpack import (
    PACK_ENTRY,
    SkillPackError,
    build_pack,
    canonical_content,
    parse_pack,
)


def _zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _valid_md(*, apply: str = "on_demand") -> bytes:
    return (
        "---\n"
        "name: 发布清单\n"
        "description: 上线前逐项核对\n"
        f"apply: {apply}\n"
        "---\n\n"
        "先灰度，再全量。\n"
    ).encode()


class TestRoundTrip:
    def test_build_then_parse(self):
        data = build_pack(
            name="发布清单",
            description="上线前逐项核对",
            body="先灰度，再全量。",
            references=(("references/check.md", "核对监控与回滚"),),
        )
        pack = parse_pack(data)
        assert pack.name == "发布清单"
        assert pack.description == "上线前逐项核对"
        assert pack.body == "先灰度，再全量。"
        assert pack.references == (("references/check.md", "核对监控与回滚"),)

    def test_canonical_content_uses_the_repository_frontmatter_writer(self):
        pack = parse_pack(build_pack(name="s", description="d", body="正文"))
        content = canonical_content(pack)
        parsed = parse_entry_frontmatter(content)
        assert getattr(parsed, "apply", None) == "on_demand"
        assert getattr(parsed, "description", None) == "d"
        assert "正文" in getattr(parsed, "body", "")

    def test_references_are_sorted_for_deterministic_packs(self):
        data = build_pack(
            name="s",
            description="d",
            body="b",
            references=(
                ("references/z.md", "z"),
                ("references/a.md", "a"),
            ),
        )
        assert [rel for rel, _ in parse_pack(data).references] == [
            "references/a.md",
            "references/z.md",
        ]


class TestRejectedPackages:
    @pytest.mark.parametrize(
        "member",
        ["evil.py", "run.sh", "index.js", "manifest.json", "bin/tool", "__init__.py"],
    )
    def test_any_code_or_manifest_member_aborts_the_whole_pack(self, member: str):
        with pytest.raises(SkillPackError, match="只准包含"):
            parse_pack(_zip({PACK_ENTRY: _valid_md(), member: b"print(1)"}))

    def test_zip_slip_is_rejected(self):
        with pytest.raises(SkillPackError):
            parse_pack(_zip({"../escape.md": b"x", PACK_ENTRY: _valid_md()}))

    def test_missing_skill_md_is_rejected(self):
        with pytest.raises(SkillPackError, match="缺少"):
            parse_pack(_zip({"references/a.md": b"x"}))

    def test_duplicate_skill_md_is_rejected(self):
        data = build_pack(name="s", description="d", body="b")
        # 手工拼一个含两个同名 member 的 zip。
        buf = io.BytesIO()
        with pytest.warns(UserWarning, match="Duplicate name"), zipfile.ZipFile(
            buf, "w"
        ) as zf:
            zf.writestr(PACK_ENTRY, _valid_md())
            zf.writestr(PACK_ENTRY, _valid_md())
        assert len(data) > 0
        with pytest.raises(SkillPackError, match="多个"):
            parse_pack(buf.getvalue())

    def test_too_many_files_is_rejected(self):
        members = {PACK_ENTRY: _valid_md()}
        for i in range(20):
            members[f"references/f{i}.md"] = b"x"
        with pytest.raises(SkillPackError):
            parse_pack(_zip(members))

    def test_oversized_uncompressed_content_is_rejected(self):
        members = {PACK_ENTRY: _valid_md(), "references/big.md": b"x" * (300 * 1024)}
        with pytest.raises(SkillPackError):
            parse_pack(_zip(members))

    def test_non_utf8_member_is_rejected(self):
        with pytest.raises(SkillPackError, match="UTF-8"):
            parse_pack(_zip({PACK_ENTRY: _valid_md(), "references/a.md": b"\xff\xfe"}))

    def test_not_a_zip_is_rejected(self):
        with pytest.raises(SkillPackError):
            parse_pack(b"this is not a zip")
        with pytest.raises(SkillPackError):
            parse_pack(b"")


class TestFrontmatterDiscipline:
    @pytest.mark.parametrize("apply", ["always", "paths", "weird"])
    def test_stated_non_on_demand_apply_is_rejected_not_silently_rewritten(
        self, apply: str
    ):
        with pytest.raises(SkillPackError, match="on_demand"):
            parse_pack(_zip({PACK_ENTRY: _valid_md(apply=apply)}))

    def test_unknown_key_is_rejected(self):
        md = b"---\nname: s\ndescription: d\ntools: [shell]\n---\n\nbody\n"
        with pytest.raises(SkillPackError, match="不支持"):
            parse_pack(_zip({PACK_ENTRY: md}))

    def test_unclosed_frontmatter_is_rejected(self):
        with pytest.raises(SkillPackError, match="未闭合"):
            parse_pack(_zip({PACK_ENTRY: b"---\nname: s\n\nbody\n"}))

    def test_duplicate_key_is_rejected(self):
        md = b"---\nname: s\nname: t\ndescription: d\n---\n\nbody\n"
        with pytest.raises(SkillPackError, match="重复"):
            parse_pack(_zip({PACK_ENTRY: md}))

    @pytest.mark.parametrize(
        "md",
        [
            b"---\nname: ../evil\ndescription: d\n---\n\nbody\n",
            b"---\nname: s\n---\n\nbody\n",
            b"---\nname: s\ndescription: d\n---\n",
        ],
    )
    def test_bad_name_or_missing_fields_are_rejected(self, md: bytes):
        with pytest.raises(SkillPackError):
            parse_pack(_zip({PACK_ENTRY: md}))


class TestBuildPackValidation:
    def test_name_and_body_limits(self):
        with pytest.raises(SkillPackError):
            build_pack(name="../evil", description="d", body="b")
        with pytest.raises(SkillPackError):
            build_pack(name="s", description="", body="b")
        with pytest.raises(SkillPackError):
            build_pack(name="s", description="d", body="   ")

    def test_reference_must_live_under_references_and_be_md(self):
        with pytest.raises(SkillPackError):
            build_pack(
                name="s", description="d", body="b", references=(("x.md", "x"),)
            )
