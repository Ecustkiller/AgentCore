"""Skill body: lead_subteam.

Nested-captain staffing HOW. WHEN lives in the nested ``delegate`` description
(same ``DELEGATE_WHEN`` as the root button, window bound to this task card);
this consult is the HOW. Not the CEO orchestration encyclopedia (coordination /
user-facing silence / 先定位入口就停 live in ``staffing``).
"""

from __future__ import annotations

from agentcore.runtime.skills.staffing import CHUNK_BY_ACCEPTANCE, TASK_FILL_HOW

_LEAD_SUBTEAM = f"""\
<子队拆法>
{CHUNK_BY_ACCEPTANCE}\
整段里程碑、空仓库多模块仍应拆。拆得清可以拆 ≠ 「凡大活必嵌套」≠ 为了编排而编排。

【这把工具】`delegate` 调用后等到子队收工才回到你（阻塞）。收工后整合交差。\
派完继续自己干 ≠ 这把工具的行为。

【怎么派】task = 目标 + 边界 + 验收，写完自成一套（子队员看不到你的窗口）。\
{TASK_FILL_HOW}\
按活的结构组队，一块则 1 人。交了某职责 ≠ 再平铺同名角色。

【整合】子队产出交上来后由你交差；交付形态仍以你这张任务卡为准。
</子队拆法>"""
