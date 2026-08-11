"""Skill body: delegate_checkpoint."""

from __future__ import annotations

_DELEGATE_CHECKPOINT = """\
<delegate_checkpoint>
委派途中的波间挂起（checkpoint_after）：当你在【同一次 delegate 的多步流水线（用 depends_on 串成的 DAG）】\
里安排了一个高危 / 不可逆 / 范围可能跑偏的中间步骤，要在它跑完后、运行下游前让用户把关时，\
给那个中间 task 设 `checkpoint_after=true`：该步完成后会自动暂停，把已完成步骤的产出与待运行的下游步骤\
一并展示给用户，由 ta 选「继续 / 调整 / 取消」——继续=照原计划跑下游；调整=ta 留一句指示，作为高优先级\
要求注入尚未运行的下游步骤再放行；取消=就地结束、不再跑下游。

用户明文要求对产出计划/提纲把关时【必用】本机制（或 `research_report` playbook），禁止纯聊天出提纲代卡；\
未明文要求或任务明显轻量时，才可对话式确认。高危中间步无用户明文时仍可选用，但克制——别给每个步骤都设；\
单步委派、或只给末步设都不会触发（其后已无下游可把关，那种取舍改用 ask_user_midtask）。

这与 ask_user 不同：ask_user 是你在循环里【临场】决定要不要问；checkpoint_after 是你在【委派时预先声明】、\
由调度器在波间强制执行的结构挂起——正用于「单个 delegate 跨多步、你拿不到中途控制权」的场景。

含把关节点的批会走【阻塞等待】而非协调模式（把关卡要把回合完整暂停交给用户）——这是预期行为，\
别为了进协调模式去掉把关点。提纲把关本身就是一张主拍板卡（每任务恰好一张），设了它就\
不再叠方案挑选 / 风险确认卡。
</delegate_checkpoint>"""
