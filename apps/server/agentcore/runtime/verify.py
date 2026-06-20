"""交付前核验·轻层守卫（finish_guard）。

模型在某轮宣布 done（不再调工具、且有正文）时，:func:`~agentcore.runtime.engine.react_loop`
不立刻接受，先过这道纯代码轻层守卫：扫产物的*可观测信号*，命中即返回锚定具体事实的
「待修正项」，由 loop 拼成系统提示注入、回炉一轮，而非照发。

这是 ReAct「唯一终止信号 = 模型自报 done」的**对称解**——给「交付前先核一道」一个不依赖
模型自觉、不经 CEO 判断的决定论闸门（CEO captain 与 worker 跑同一个 react_loop，故一处
落点同时盖住两条路）。本模块只产出结论与注入文案，保持纯函数、可独立单测，处置（回炉 /
放行 / 计数）在 react_loop 里。

第一刀只做一条轻层校验：**造引用拦截**——正文角标 ``[n]`` 指向不存在的来源卡（编号 < 1
或 > 来源数）。这是真实运行里出过的事故（CEO 直答用了 [25][27] 而实际仅 24 源，直接违反
基座提示词「绝不编造引用」却不自知），纯机械可判、近零成本。后续轻层（残留 TODO / JSON
可解析）与重层（要跑 / 要重算 / 换眼睛找漏 / 回源对照）在此扩展。

→ 见设计: docs/03-AI核心/执行引擎架构设计.md（ReAct 循环 · 交付前核验）
"""

from __future__ import annotations

from agentcore.runtime.citations import out_of_range_markers


def finish_guard(content: str, *, citation_count: int) -> list[str]:
    """模型宣布 done 时的轻层守卫：返回「待修正项」列表，空列表 = 放行交付。

    每条都是一句锚定具体事实的修正指令（镜像 ``loop_controller`` 的注入风格——锚到可观测
    的实事而非空泛的「再想想」），由 react_loop 经 :func:`format_guard_steer` 拼成系统
    提示注入、回炉一轮。纯函数、不经 LLM、不靠 CEO 自觉，可独立单测。

    第一刀只查造引用：:func:`~agentcore.runtime.citations.out_of_range_markers` 抓出
    正文里指向不存在来源卡的角标 ``[n]``（编号 < 1 或 > ``citation_count``）。这正是基座
    提示词「绝不编造引用」的机械兜底。``citation_count`` 是本回合实际收集到的来源卡数；
    为 0 时正文里出现任何 ``[n]`` 都视为编造（与客户端「越界角标降级为纯文本」同义）。
    """
    reworks: list[str] = []
    stray = out_of_range_markers(content, citation_count)
    if stray:
        marks = "、".join(f"[{n}]" for n in stray)
        reworks.append(
            f"正文用了 {marks} 这些来源角标，但本回合实际只有 {citation_count} 条来源——"
            "它们指向不存在的来源卡，属于编造引用（违反「绝不编造引用」）。请删除这些角标、"
            "改成真实存在的来源编号，或为该论断补上可检索到的来源；没有依据就直接去掉这处引用。"
        )
    return reworks


def format_guard_steer(reworks: list[str]) -> str:
    """把待修正项拼成一条注入模型的系统提示（空列表 → 空串）。

    镜像 ``loop_controller`` 各 steer 的「``[系统提示]`` + 锚定事实」风格：陈述查出的具体
    问题、点明下一步（改正或补来源），不空泛说教。由 react_loop append 进真实窗口、回炉
    一轮——故措辞允许模型继续调检索工具补依据，而非强制只能改写正文。
    """
    if not reworks:
        return ""
    items = "\n".join(f"- {r}" for r in reworks)
    return (
        "[系统提示] 交付前核验未通过，发现以下问题：\n"
        f"{items}\n"
        "请修正后再给出最终答案；如需补充依据，可继续调用检索工具后再作答。"
    )
