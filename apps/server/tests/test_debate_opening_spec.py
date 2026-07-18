"""主持人开场白 prompt 契约（零 LLM）：钉住语体 / 三拍 / 禁词，防回落「大众解说腔」。"""

from __future__ import annotations

from agentcore.runtime.debate.moderator_agenda import _FRAME_SYSTEM, _OPENING_SPEC


def test_opening_spec_is_formal_moderator_register():
    """开场白规格：赛制主持语域 + 三拍 + 长度带；旧唠嗑腔锚已拆除。"""
    assert "真实辩论赛主持人" in _OPENING_SPEC
    assert "面向全场" in _OPENING_SPEC
    assert "不对用户称「你」" in _OPENING_SPEC
    assert "80–120" in _OPENING_SPEC
    # 三拍要素
    assert "宣题" in _OPENING_SPEC
    assert "亮场" in _OPENING_SPEC
    assert "定焦" in _OPENING_SPEC
    # 形态适配亮场措辞
    assert "正方主张" in _OPENING_SPEC
    assert "红队将审查" in _OPENING_SPEC
    assert "视角展开" in _OPENING_SPEC
    # 禁令保留
    assert "不剧透结论" in _OPENING_SPEC
    assert "不站队" in _OPENING_SPEC
    assert "禁网络梗" in _OPENING_SPEC
    # 旧大众解说腔锚不得回潮
    for banned in (
        "普通观众",
        "大白话",
        "说人话",
        "先帮你把最要紧",
        "帮你定的",
    ):
        assert banned not in _OPENING_SPEC, f"旧口吻残留: {banned!r}"
    # 示范句须是庄重赛制腔（含宣题/亮场/定焦骨架），且不对用户称「你」
    assert "口吻示范" in _OPENING_SPEC
    assert "展开辩论" in _OPENING_SPEC
    assert "首轮焦点" in _OPENING_SPEC
    assert "帮你" not in _OPENING_SPEC


def test_frame_system_anchors_moderator_register():
    """frame system 锚定开场白与专业辩论主持同语域。"""
    assert "开场白与专业辩论主持同语域" in _FRAME_SYSTEM
