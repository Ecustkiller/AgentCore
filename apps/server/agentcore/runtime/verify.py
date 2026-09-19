"""交付前核验·轻层守卫（finish_guard）。

模型在某轮宣布 done（不再调工具、且有正文）时，:func:`~agentcore.runtime.engine.react_loop`
不立刻接受，先过这道纯代码轻层守卫：扫产物的*可观测信号*，命中即返回锚定具体事实的
「待修正项」，由 loop 拼成系统提示注入、回炉一轮，而非照发。

这是 ReAct「唯一终止信号 = 模型自报 done」的**对称解**——给「交付前先核一道」一个不依赖
模型自觉、不经 CEO 判断的决定论闸门（CEO captain 与 worker 跑同一个 react_loop，故一处
落点同时盖住两条路）。本模块只产出结论与注入文案，保持纯函数、可独立单测，处置（回炉 /
放行 / 计数）在 react_loop 里。

对话气泡 **不因引用回炉**：``#rN``、悬空 ``[n]``、书目形态不是 ``finish_guard`` 的命中项
（来源卡 = 已登记非 blocked，含 search-only；未登记号留白字）。
轻层覆盖两类**纯机械、近零误报**的校验：

1. **结构完整性**——代码围栏未闭合（``` 开了没收尾、后文整片被当代码渲染）。
   空语言围栏（标了 ``python`` 却空体）已撤（质检启发式）。
2. **交付验收对照**（仅 CEO：``check_citations`` + 本回合已发射的 ``delivery_verdict``）——
   **真源 = 对账档位**（见 ``closing_posture``）：``delivered``=正式完成；
   ``partial``/``notes``≈草稿·部分；``blocked``=阻塞。档位非正式完成时不得姿势 A
   （完整交付 / 收卷收齐 / 完整可用 / 修好验绿闭集；**禁止**案面加完成话术词修案）。
   无对账卡 / 本轮 ``no_batch`` 不拦正文。**产物结构窄闸已撤**：不再因空盘「请下载」/
   无 ``.pptx`` 说 PPT / 点名缺席路径扫正文回炉（与零写落盘声称同构；交付诚实走档位影子
   与磁盘）。有交付卡时终稿超 ``engine_ceo_overview_max_chars`` → 只打
   ``engine.finish_guard_honesty_shadow``（``hit=overview_length``），
   不回炉、不改写终稿。

刻意**不**纳入「残留 TODO / 填空占位」之类：法律垂直会正当地在合同模板留空待填、worker 也会
如实写「该资料待客户提供」，机械判会误伤——轻层的立身之本是近零误报，宁缺毋滥。后续轻层（如
受限的 JSON 可解析）与重层（要跑 / 要重算 / 换眼睛找漏 / 回源对照）在此扩展。

**统一底线**：结构完整性两查对 CEO 与 worker 同样成立，二者收尾都过这道关（worker 回炉经
``run_output_reset`` 干净重写其卡片）；交付验收对照（含概览篇幅）仅 CEO 路径开。

→ 见设计: docs/03-AI核心/执行引擎架构设计.md（ReAct 循环 · 交付前核验）
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.runtime.delegate.delivery_status import DeliveryVerdict


def finish_guard(
    content: str,
    *,
    citation_count: int = 0,
    check_citations: bool = True,
    delivery_verdict: DeliveryVerdict | None = None,
    overview_max_chars: int | None = None,
) -> list[str]:
    """模型宣布 done 时的轻层守卫：返回「待修正项」列表，空列表 = 放行交付。

    每条都是一句锚定具体事实的修正指令（镜像 ``loop_controller`` 的注入风格——锚到可观测
    的实事而非空泛的「再想想」），由 react_loop 经 :func:`format_guard_steer` 拼成系统
    提示注入、回炉一轮。纯函数、不经 LLM、不靠 CEO 自觉，可独立单测。

    这是**所有 react_loop 收尾共过的统一底线**——CEO captain 与 worker 都在 done 点过此关。
    对话气泡不扫 ``[n]`` / ``#rN`` / 书目（``citation_count`` 已不参与判定）。现查两类：

    1. **结构完整性**（始终查）：:func:`_code_fence_reworks`。
    2. **交付验收对照**（仅 ``check_citations``）：
       - 收口诚实性（``closing_honesty_rework``）：真源=``delivery_verdict`` 档位；
         非正式完成不得姿势 A（默认影子）；无卡 / ``no_batch`` 不拦正文；
         产物结构窄闸已撤；B1 空心措辞扫描已删；
       - 有交付卡时的概览篇幅（``overview_max_chars``，默认读设置）——只影子观测。
    """
    _ = citation_count  # 对话不再因角标回炉；调用面仍可传。
    reworks: list[str] = []
    reworks.extend(_code_fence_reworks(content))
    if check_citations:
        from agentcore.runtime.closing_posture import closing_honesty_rework

        honesty = closing_honesty_rework(content, delivery_verdict)
        if honesty:
            reworks.append(honesty)
        reworks.extend(
            _overview_length_reworks(
                content,
                delivery_verdict,
                overview_max_chars=overview_max_chars,
            )
        )
    return reworks


def _resolve_overview_max_chars(explicit: int | None) -> int:
    """``explicit`` wins for tests; else ``engine_ceo_overview_max_chars`` (≤0 = off)."""
    if explicit is not None:
        return int(explicit)
    from agentcore.config import settings

    return int(settings.engine_ceo_overview_max_chars or 0)


def _overview_length_reworks(
    content: str,
    delivery_verdict: DeliveryVerdict | None,
    *,
    overview_max_chars: int | None = None,
) -> list[str]:
    """C2：有交付卡时终稿超阈值只打影子、不回炉（字数是「未复述 UI」的启发式代理）。"""
    if delivery_verdict is None:
        return []
    if not content or not content.strip():
        return []
    limit = _resolve_overview_max_chars(overview_max_chars)
    if limit <= 0:
        return []
    n = len(content.strip())
    if n <= limit:
        return []
    from agentcore.runtime.closing_posture.core import _log_honesty_shadow

    _log_honesty_shadow("overview_length", delivery_verdict)
    return []


def _code_fence_reworks(content: str) -> list[str]:
    """结构完整性轻检：代码围栏未闭合（``` 开了没收尾）。

    空语言围栏（标了语言却空体）已撤。单遍扫行、把每个行首 ``` 当作开/合切换
    （标准 Markdown 同字符围栏不嵌套）；扫完仍在块内记一条未闭合项。
    """
    reworks: list[str] = []
    in_fence = False
    for line in content.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
    if in_fence:
        reworks.append(
            "正文里有一个用 ``` 开启的代码块没有闭合（缺少结尾的 ```）——会导致后面的内容"
            "全部被当作代码渲染。请补上结尾的 ```，或删除多余的起始标记。"
        )
    return reworks


def format_guard_steer(reworks: list[str]) -> str:
    """把待修正项拼成一条注入模型的系统提示（空列表 → 空串）。

    镜像 ``loop_controller`` 各 steer 的「``[系统提示]`` + 锚定事实」风格：陈述查出的具体
    问题、点明下一步（改正或补来源），不空泛说教。由 react_loop append 进真实窗口、回炉
    一轮——故措辞允许模型继续调检索工具补依据，而非强制只能改写正文。

    因这条以 ``role="user"`` 进窗口（reasoner 靠一条 user 轮可靠触发下一步动作），模型易把它
    当成用户在纠错并回致谢/复述寒暄——那句会随正常旁白通道漏进可见交付。故文案显式自证
    「系统自动核验、非用户反馈」并禁止致谢/复述/寒暄；共享基座提示词
    的 ``<输入>`` 段对所有 ``[系统提示]`` 注入做同一约束（见 resolve/prompt.py）。
    """
    if not reworks:
        return ""
    items = "\n".join(f"- {r}" for r in reworks)
    return (
        "[系统提示] 交付前核验未通过（系统自动核验，非用户反馈），发现以下问题：\n"
        f"{items}\n"
        "请直接修正正文后再给出最终答案；如需补充依据，可继续调用检索工具后再作答。"
        "不要为此道谢、复述或寒暄，直接改。"
    )
