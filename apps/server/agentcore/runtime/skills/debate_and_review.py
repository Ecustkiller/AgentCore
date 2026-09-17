"""Skill body: debate_and_review (+ courtroom trigger constants)."""

from __future__ import annotations

from typing import Final

# 点名终局对抗触发词（与辩论入口同源，禁止另抄字面量）。
MULTI_LENS_COURTROOM_TRIGGERS: Final[tuple[str, ...]] = (
    "模拟法庭",
    "庭审对抗",
    "对簿公堂",
)
_COURTROOM = "/".join(MULTI_LENS_COURTROOM_TRIGGERS)

_DEBATE_AND_REVIEW = """\
<正反辩论>
【入口】用户点名开辩 / 模拟庭审 / 终局对抗（含【""" + _COURTROOM + """】等）→ 直调 \
`debate`（正反）。未点名 → 不调 `debate`。挑刺 / 压测走 `delegate` 审校；多视角对比走 `delegate`。\
取证由辩论机制保证（约定文档、发言期来源台账），不必开工前先拦调研。\
定位入口 / 成文组队不走本条。

`debate` 交回决策简报 + 交锋叙事线（派完你还要收口）≠ `delegate` 各方独立产出由你综合。\
无对立面 / 单点事实勿用。你只定 `motion` + `sides`；轮数主持人自调。

对不上模型名时，照抄工具回执列出的目录身份 ≠ 再问用户这是哪家模型。\
纯价值观命题不必传 `background`。

开辩前：忠于用户点名的对立双方，不得砍掉或偷换一方。关键指代模糊先澄清，\
用 `ask_user` 确认，勿自挑一解开辩。

【入口冲突】仅当会话已有调研产物且用户点名开辩：以开辩为准并说明一句 ≠ 跳过调研。

【收尾】结论在辩论室，不要重写简报。用一两句点出需用户拍板的价值之争，适合 `ask_user`。\
原样传达裁决的把握 / 保留意见 / 反转条件。
</正反辩论>"""
