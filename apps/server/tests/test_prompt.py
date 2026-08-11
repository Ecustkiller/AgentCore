"""Tests for system-prompt assembly (`assemble_system_prompt`) and the slim CEO core.

Pins two things:

1. The shared <output_style> contract that keeps the whole team's voice professional
   and anti-"AI slop" — it lives in the base prompt, so it must reach both the CEO
   chat agent and every delegated worker, and survive the optional memory /
   attachment-context sections layered on top. (<tool_safety> used to be shared here
   too, but 按角色 right-size 反向 moved it onto the worker identities — the coordinator
   CEO holds only read-only tools — so this file pins its ABSENCE from the base/CEO
   path; the worker-side presence is pinned in tests/runs_executor/test_identities.py.)
2. The SLIM CEO core (提示词瘦身 P2): ``_CEO_CORE_HINT`` keeps only the always-on
   routing spine (tool boundary / split criterion / hidden-context rule / same-layer
   pipeline / synthesize-don't-restate) + a pointer to ``consult_skill`` and the
   能力目录. The rarely-used「怎么做」detail (multi-round debate / nested delegation /
   asking the user / revise) is moved into system Skills
   (runtime/skills.py, see test_skills.py) — so it must NOT ride the core every turn.
"""

import re

from agentcore.runtime.resolve.prompt import (
    _CEO_CORE_HINT,
    _CEO_VISUALIZATION_HINT,
    CHAT_CITATION_HINT,
    assemble_system_prompt,
    compose_ceo_chat_prompt,
    derive_ceo_addon,
)
from agentcore.runtime.skills import _TEAM_ORCHESTRATION_ADVANCED, build_system_skill_registry


def test_derive_ceo_addon_splits_shared_prefix_from_full_ceo_prompt():
    base = assemble_system_prompt()
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill", "ask_user"},
    )
    addon = derive_ceo_addon(base, ceo)
    assert addon
    assert "<role>" in addon
    assert "<output_style>" not in addon
    assert ceo.startswith(base)
    assert addon == ceo[len(base) :].lstrip("\n")
    assert ceo == base + ceo[len(base) :]


def test_output_style_block_present_in_base():
    out = assemble_system_prompt()
    assert "<output_style>" in out
    assert "</output_style>" in out


def test_emoji_banned_with_soft_carve_out():
    out = assemble_system_prompt()
    assert "emoji" in out
    # Default-off, but allowed when the user uses one first or explicitly asks.
    assert "除非用户" in out
    assert "明确要求" in out


def test_anti_filler_and_formatting_restraint():
    out = assemble_system_prompt()
    # No sycophantic openers/closers.
    assert "好问题" in out
    assert "希望对你有帮助" in out
    # Formatting is proportional, not decorative.
    assert "滥用列表" in out


def test_render_capabilities_advertised():
    out = assemble_system_prompt()
    assert "Markdown" in out
    assert "LaTeX" in out


def test_untrusted_content_guard_frames_external_and_cross_agent_text():
    # <untrusted_content> (PI-003 + PI-006, 提示注入防御纵深) is the trust boundary the API
    # role="tool" alone doesn't enforce: external content — AND text authored by another Agent —
    # is DATA, never a command. It lives in the SHARED base so it reaches every worker AND the
    # composed CEO. Pin (1) the block + the data-not-command framing and a canonical injection
    # idiom it must resist, (2) that it names the PI-003 channels (tool/web/file/memory) AND the
    # PI-006 cross-agent channels (teammate notes / upstream product / delegated task), and
    # (3) that it survives into the composed CEO prompt — so a refactor can't silently drop the
    # guard or narrow it back to non-agent content only.
    base = assemble_system_prompt()
    assert "<untrusted_content>" in base and "</untrusted_content>" in base
    assert "【数据】" in base and "不是对你下达的指令" in base
    assert "忽略上面的指令" in base
    for token in ("工具返回", "网页", "文件", "长期记忆"):  # PI-003 external channels
        assert token in base, f"untrusted_content lost the {token} channel"
    for token in ("队友便签", "上游", "委派"):  # PI-006 cross-agent channels
        assert token in base, f"untrusted_content lost the cross-agent {token} framing"
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<untrusted_content>" in ceo and "队友便签" in ceo


def test_system_feedback_block_frames_engine_steers_as_non_user():
    # 回合中引擎自动注入的 [系统提示]（交付前核验 / 熔断 / 循环提醒）以 role=user 进窗口，
    # 模型易误当用户纠错、回一句「谢谢指正，我重新整理」，那句寒暄再随正常旁白通道漏进可见交付
    # （真实事故）。共享 base 的 <system_feedback> 把这类注入定性为「系统自动机制、非用户发言」并禁止
    # 致谢/复述/寒暄——放共享 base 所以 CEO 与每个 worker 都受约束。Pin 住块、非用户定性、以及点名要
    # 避免的原话，防重构悄悄丢掉。
    base = assemble_system_prompt()
    assert "<system_feedback>" in base and "</system_feedback>" in base
    assert "[系统提示]" in base
    assert "不是用户" in base  # 定性：非用户发言
    assert "谢谢指正" in base  # 点名要避免的原话
    # 复合进 CEO 提示后仍在（worker 走 bare base，天然带上）。
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<system_feedback>" in ceo


def test_tool_safety_moved_out_of_shared_base_and_ceo():
    # 按角色 right-size (反向): the environment-mutation caution (<tool_safety>) used to ride
    # the shared base, so the CEO carried it too — but the coordinator CEO holds only
    # read-only tools (build_ceo_tool_registry); a caution about write/delete/execute tools
    # it cannot call was inert weight. It moved onto the worker identities
    # (executor.identities._WORKER_TOOL_SAFETY_POLICY, pinned in test_identities.py). Pin its
    # ABSENCE from the base AND the composed CEO prompt so a refactor can't quietly re-inflate
    # the CEO prefix by folding it back into the shared base.
    base = assemble_system_prompt()
    assert "<tool_safety>" not in base
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<tool_safety>" not in ceo


def test_tool_use_block_teaches_parallel_calls():
    # The executor already runs a round's tool_calls concurrently (engine
    # _execute_tools: asyncio.gather + semaphore). The only missing lever was telling
    # the model to BATCH independent calls into one round so that concurrency is
    # actually used (otherwise the ReAct loop emits one call per round = serial). This
    # guidance lives in the shared base prompt so both the CEO and every worker batch
    # independent retrievals. Pin it so a refactor can't silently re-idle the
    # concurrent executor.
    out = assemble_system_prompt()
    assert "<tool_use>" in out
    assert "互相独立" in out
    assert "并发" in out
    assert "一次性" in out


def test_tool_use_block_documents_web_search_query_contract():
    # A3 查询契约须进共享 system prompt（schema alone 不够）：模型在研究压力下常倾倒长关键词串。
    out = assemble_system_prompt()
    assert "web_search" in out and ("精简" in out or "核心词" in out)
    assert "截断" in out or "规范化" in out
    assert "明示" in out
    assert "无法规范化才拒绝" not in out
    assert "≤8 词" not in out
    # 可信优先：搜到 ≠ 可挂 #rN；成稿挂号须先深读
    assert "搜到" in out and ("可挂来源号" in out or "可挂 #rN" in out)
    assert "read_url" in out
    assert "文字概括" in out


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
        memory_markdown="- 用户偏好简洁回复",
        extra_context="<attached_files>...</attached_files>",
    )
    # The shared style block is not crowded out by the optional sections.
    assert "<output_style>" in out
    assert "用户偏好简洁回复" in out
    assert "<attached_files>" in out


def test_style_precedes_ceo_only_core_when_composed():
    # The CEO prompt is base + core hint (see pipeline.run_chat_pipeline). The
    # shared style must come from the base, independent of the CEO-only core.
    base = assemble_system_prompt()
    assert "<output_style>" in base
    assert "<output_style>" not in _CEO_CORE_HINT


def test_charting_detail_moved_out_of_worker_base():
    # 按角色 right-size: the DETAILED charting HOW (chart-type selection + mermaid /
    # markmap / vega-lite syntax) is CEO-only now — it must NOT ride the shared base,
    # or every delegated worker would carry ~500 tokens that mainly serve the
    # user-facing voice. Pin its absence so a refactor can't quietly re-inflate the
    # worker prompt by folding the detail back into the shared base.
    base = assemble_system_prompt()
    for token in ("mermaid", "markmap", "vega-lite"):
        assert token not in base, f"charting detail '{token}' leaked into the worker base"
    # The one-line affordance survives, so a doc-writing worker still knows charts render.
    assert "图表" in base


def test_visualization_block_rides_only_the_composed_ceo_prompt():
    # The moved charting HOW lives in the CEO-only <visualization> block and reaches
    # the model ONLY through compose_ceo_chat_prompt (the CEO path) — never the bare
    # base (the worker path). Pins the split end-to-end.
    assert "<visualization>" in _CEO_VISUALIZATION_HINT
    assert "mermaid" in _CEO_VISUALIZATION_HINT

    base = assemble_system_prompt()
    ceo = compose_ceo_chat_prompt(
        base,
        skill_registry=build_system_skill_registry(),
        ceo_tool_names={"delegate", "consult_skill"},
    )
    assert "<visualization>" in ceo  # CEO carries the detailed charting HOW…
    assert "mermaid" in ceo
    assert "<visualization>" not in base  # …workers (base only) do not.


def test_core_states_coordinator_tool_boundary():
    # 协调者 CEO: mainly read/retrieval; production/mutation → delegate. Narrow
    # exceptions (host_shell · local terminal for pure start/stop/list / 跑起来) stay pinned.
    hint = _CEO_CORE_HINT
    assert "只读" in hint
    assert "delegate" in hint
    # The hint must steer production/mutation to a worker, not the CEO's own hands.
    assert "交给 worker" in hint
    assert "本机运行态" in hint
    assert "跑起来" in hint or "打开项目看一下" in hint
    assert "报 URL" in hint
    assert "验证员" in hint  # 禁止为此 delegate 验证员/browser
    assert "禁止" in hint and "host_shell" in hint
    assert "terminal" in hint
    # OS 排查意图多解才先澄清；「桌面有个××」走 grant 发现，不算盲探、禁先问文件名。
    assert "本机 Host" in hint
    assert "host_os_log_summary" in hint
    assert "三分日志" in hint
    assert "Get-WinEvent" in hint or "journalctl" in hint
    assert "澄清意图" in hint
    assert "扫路径" in hint or "盲探" in hint
    assert "OS 排查" in hint or "排查意图" in hint
    assert "不算" in hint and "盲探" in hint
    assert "禁止" in hint and "文件名" in hint


def test_core_teaches_split_criterion_over_count():
    # 路由清晰化：按活的自然缝拆人；第一拍一句定方向；短文落盘单人。
    hint = _CEO_CORE_HINT
    assert "独立" in hint and "并行" in hint
    assert "自然缝" in hint
    assert "不是你能不能写" in hint  # 判据=结构，「我自己写更快」不构成自己答理由
    assert "拿不准先少派" in hint
    assert "可分解" in hint and "质量面" in hint
    assert "finalize=true" in hint and "机械单步" in hint
    # 结局分层：挡路才讨论开场 ask；未明示成文宜 A parallel_brief；
    # 明示成文可 research_report，但须成文梯度（档 2 轻成文勿满编；档 3 才满编）
    assert "结局分层" in hint
    assert "ask·挡路" in hint or "挡路" in hint
    assert "讨论开场" in hint
    assert "先多角度摸清" in hint
    assert "写成文档" in hint
    assert "暂不派队" in hint
    assert "对话本身" in hint  # 共创/审美等桌上结果已是对话 → 不发卡
    assert "催收敛" in hint or "候选菜单" in hint
    assert "内部编制" in hint
    assert "明示成文不拦" in hint
    assert "parallel_brief" in hint
    assert "对齐推进" in hint or "默认走 A" in hint or "默认 A" in hint
    assert "research_report" in hint
    assert "成文交付" in hint or "成文梯度" in hint or "成篇" in hint
    assert "禁止" in hint and "research_report" in hint  # A / 档 2 禁套满编
    assert "成文梯度" in hint
    assert "档 2" in hint and "轻成文" in hint
    assert "学术审校" in hint
    assert "少扇出" in hint or "常 2" in hint
    assert "论文" in hint and ("资料" in hint or "开源" in hint)  # 论文/开源 ≠ 明示成文
    # 派摸底验收：手写/playbook=none 也要目标·手段·收工；够用即停 + handoff
    assert "派摸底" in hint or "摸底·验收" in hint or "了解到什么算够" in hint
    assert "够用即停" in hint
    assert "handoff" in hint
    assert "file_list" in hint and ("grep" in hint or "code_search" in hint)
    assert "每个 app" in hint and "package.json" in hint
    assert "禁止" in hint and "名单" in hint
    assert "已知路径" in hint
    assert "含糊" in hint and "根" in hint
    assert "无限深挖" in hint or "更全" in hint
    # 三路/多路调研缺主体：硬 ask + 预填 default；continue=确认默认；禁静默自拟
    assert "缺主体" in hint
    assert "静默自拟" in hint
    assert "按确认默认" in hint
    assert "default" in hint
    assert "不得 continue 派工" in hint or "无 default" in hint
    # 案 ask-empty-continue-default-dispatch：决策/澄清短问同样须 default；禁空续另拟叠先问你
    assert "决策/澄清短问" in hint
    assert "先问你" in hint
    # 午后巡 d4d5/53f0：继续须承接上轮确认项；新建仓库/本地目录须 default 路径
    assert "继续·承接确认项" in hint
    assert "短确认·只补缺口" in hint
    assert "prior_delivery_gaps" in hint
    assert "整锅重派" in hint
    assert "等待确认后再派工" in hint
    assert "默认路径" in hint
    assert "一人包办" in hint or "自搜+成文" in hint
    assert "角 prose" in hint and "仅主笔落盘" in hint
    assert "form=files" in hint
    assert "独立审校" in hint
    assert "调研→撰稿" in hint
    assert "质量缝" in hint
    # 路由：禁止思考里先干完（强制「方向：…」一句模板已撤，试跑中）。
    assert "禁止长篇路由推演" in hint
    assert "完整设计" in hint  # 禁思考里先写完整设计
    assert "内部术语" in hint
    assert "内部工具名" in hint
    assert "短文" in hint and "存文件" in hint
    assert "主路径" in hint and "完整" in hint and "file_write" in hint
    assert "禁止】整篇一次 file_write" not in hint
    assert "贴报错自诊" in hint
    assert "参数不是合法 JSON" in hint
    assert "修引号" in hint or "转义" in hint
    assert "勿先" in hint and "ask_user_kickoff" in hint
    assert "糊建站" in hint or "做个网站" in hint
    assert "短问" in hint or "短澄清" in hint
    assert "提案墙" in hint
    # 点名载体/手段·顾问短对齐（与规格已齐正交；禁硬闸/format_options；禁单场景剧本）
    assert "点名载体" in hint or "载体/手段" in hint
    assert "顾问" in hint
    assert "recommended" in hint
    assert "零摩擦" in hint
    assert "规格已齐" in hint
    assert "内容齐" in hint or "手段已核" in hint
    assert "可读" in hint or "可扫" in hint or "可编辑" in hint
    assert "不得" in hint and ("吞掉" in hint or "delegate" in hint)
    assert "SmartArt" not in hint and "DrawingML" not in hint
    assert "极宽" not in hint
    assert "format_options" in hint  # 禁复活（以禁止语境出现）
    assert "pptx" in hint.lower() and "marp" in hint.lower()
    assert "先设计再实现" in hint
    assert "只留方向句" in hint
    assert "1 人两段" in hint or "一人两段" in hint
    assert "真两段" in hint
    assert "假两段" in hint
    assert "同一 task" in hint  # 禁同 task 文案冒充两段
    assert "规格已齐" in hint
    assert "playbook_args.topic" in hint
    assert "立刻派 ≠ 立刻全量" in hint or "立刻全量" in hint
    assert "编排自主" in hint
    assert "摸底波" in hint
    assert "根委派切片诚实" in hint or "路径 A" in hint or "路径 B" in hint
    assert "嵌套扇出" in hint or "单 lead" in hint
    assert "凡大活必嵌套" in hint
    assert "并行写盘" in hint
    assert "私有" in hint  # 私有 path / 笔记
    assert "MVP" in hint or "契约" in hint
    assert "多屏" in hint and ("大原型" in hint or "单文件" in hint)
    assert "完整可玩" in hint
    assert "规格已齐 ≠ 全量" in hint or "规格已齐≠全量" in hint
    assert "结构槽" in hint or "playbook_args" in hint
    assert "桌面壳" in hint or "多进程" in hint
    assert "playbook=none" in hint
    assert "可跑闭环" in hint or "核心运行时" in hint
    # 交付档 → intensity / playbook（结构槽，禁意图分类器）
    assert "交付档" in hint
    assert "intensity" in hint
    assert "solo" in hint and "standard" in hint
    assert "lean" in hint and "full" in hint
    assert "一页先上" in hint or "一页先上线" in hint
    assert "品牌站" in hint
    assert "工具壳" in hint
    assert "模块流水线" in hint
    assert "只改一处" in hint
    assert "桌上结果" in hint or "桌上档" in hint
    assert "禁止" in hint and ("intensity=full" in hint or "满编" in hint)
    assert "做个网站" in hint
    assert "展示页" in hint or "业务应用" in hint
    # 混合分流：边界未钉 ≠ 绿场 SPA 满档 build_app；五阶段仅进入后
    assert "build_app" in hint
    assert "不硬拒" in hint
    assert "边界未钉" in hint or "轻切片" in hint or "少节点" in hint
    assert "轻切片" in hint or "1～2" in hint
    assert "五波" in hint or "脚手架" in hint
    assert "五阶段" in hint
    assert "问还是派·中性" in hint or "不偏" in hint
    # P3 路由探针硬错对治：贴码写回强制派、点名实体扇出。
    assert "写回" in hint and "必须" in hint and "delegate" in hint
    # 案 ceo-claim-edit-without-write 软Ⅱ′：零写盘禁假已改 + 禁默认整文件手贴。
    assert "诚实落盘" in hint
    assert "整文件自行粘贴" in hint or "整文件" in hint
    # 软Ⅱ′ regress 辅线：用户明确不要自操作后禁甩「请你替换整个文件」，须 delegate 写盘。
    assert "不要自己操作" in hint or "直接改文件" in hint
    assert "请你替换整个文件" in hint
    assert "delegate" in hint and "写盘" in hint
    # 巡检案 A：无写盘成功/工具失败禁成功口吻；禁复读上一轮启服套话。
    assert "已完成调整" in hint and "已成功修改" in hint
    assert "相关工具失败" in hint
    assert "启服" in hint and "复读" in hint
    assert "落盘说明" not in hint  # 不恢复 mutation honesty 横幅文案
    # 午后巡 12d：面板可见对账；server/云端须说清；认错后禁立刻再报验收通过
    assert "面板可见·落盘对账" in hint
    assert "文件」面板" in hint or "文件面板" in hint
    assert "server" in hint.lower() or "云端" in hint
    assert "上次说错了" in hint or "此前误报" in hint
    assert "验收通过" in hint
    # 午后巡 e670：标完成前先报真实断点
    assert "收尾·先报断点" in hint
    assert "都实现了" in hint or "收尾完成" in hint
    assert "断点" in hint
    # 案 merge-pipeline-skeleton-busy-claim A′：多源合并→单写手成篇；骨架禁审校清理连环。
    assert "多源合并" in hint and "成篇优先" in hint
    assert "CEO 自写" in hint  # 禁表出现在提示里
    assert "审校" in hint and "清理" in hint
    assert "流水线已在执行" in hint or "合并进行中" in hint
    # 案 cloud-web-install-deny-claim-verified A：云端不能装包时禁「自检全过/跑绿」。
    assert "绿场 Web" in hint or "云端装包" in hint
    assert "自检全过" in hint or "跑绿" in hint
    assert "单测已绿" in hint or "跑绿" in hint
    # 案 fake-dispatch-stall-claim A：未 delegate 前禁「已派/已开工」；ask_user 须「先确认再派」。
    assert "派工·时序诚实" in hint
    assert "先确认再派" in hint or "尚未派工" in hint
    assert "已开工" in hint  # 禁表出现在提示里
    # 夜巡残差 A′：无 ask_user 的 kickoff+pause / 「继续」重派；开工预览确认前禁「已跑起来」。
    assert "尚未真正派工" in hint or "还在准备" in hint
    assert "kickoff" in hint or "方向：派团队" in hint
    assert "确认后开工" in hint or "方案已备好" in hint
    assert "至少 N 人" in hint or "tasks 至少" in hint
    # 按场面 consult：与能力目录 preamble 同强度（禁「可选 vs 必先查」对打）。
    from agentcore.runtime.skills import CONSULT_TEAM_ORCH_BY_SCENE

    assert CONSULT_TEAM_ORCH_BY_SCENE in hint
    assert "可选，非开场必做" not in hint
    assert "先 `consult_skill(team_orchestration_advanced)` 再规划" not in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "形状词汇" in skill
    assert "实质任务该派就派" in skill or "自然缝" in skill
    assert "教学示例形状" in skill and "对照学形状" in skill
    assert "免手搓" not in skill  # 旧「是就直接套 / 免手搓」广告口径已撤
    assert "并列对象分组" in skill and "独立多透镜诊断" in skill
    assert "实现+独立验证" in skill  # 构建轻档双人底线
    assert "跨域合成" in skill or "按工种" in skill
    assert "必读锚点" in skill or "≤2–3" in skill or "≤2-3" in skill
    assert "第一棒" in skill or "壳层" in skill
    assert "多屏" in skill and ("大原型" in skill or "单文件" in skill)
    assert "完整可玩" in skill
    assert "规格已齐 ≠ 全量" in skill or "规格已齐≠全量" in skill
    assert "结构槽" in skill or "playbook_args" in skill
    assert "设计波" in skill or "约定文档说明" in skill
    assert "真两段" in skill
    assert "假两段" in skill
    assert "同一 task" in skill
    assert "桌面壳" in skill or "多进程" in skill
    assert "playbook=none" in skill
    assert "可跑闭环" in skill or "核心运行时" in skill
    assert "根委派切片诚实" in skill or "嵌套扇出" in skill

def test_catalog_preamble_matches_core_consult_intensity():
    """核与能力目录 preamble 共用同一句按场面强度。"""
    from agentcore.runtime.skills import (
        CONSULT_PRODUCT_BUG_TRIAGE_BY_SCENE,
        CONSULT_PRODUCT_HELP_BY_SCENE,
        CONSULT_TEAM_ORCH_BY_SCENE,
        render_skill_directory,
    )

    directory = render_skill_directory(
        build_system_skill_registry(),
        {"delegate", "consult_skill", "ask_user", "debate"},
    )
    assert CONSULT_TEAM_ORCH_BY_SCENE in _CEO_CORE_HINT
    assert CONSULT_TEAM_ORCH_BY_SCENE in directory
    assert CONSULT_PRODUCT_HELP_BY_SCENE in directory
    assert CONSULT_PRODUCT_BUG_TRIAGE_BY_SCENE in directory
    assert "先 consult `team_orchestration_advanced` 再决定团队形态" not in directory
    assert "纯对话式回答自己答即可，无需 consult" not in directory


def test_core_teaches_delegate_graph_and_coordinate_invariants():
    # 产品 AI 自述委派机制时曾误称「一次只能一个 delegate、同步阻塞」。
    # 常驻 core 钉短判决；HOW 在 team_orchestration_advanced。
    hint = _CEO_CORE_HINT
    assert "一回合一张协作图" in hint
    assert "coordinate=false" in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "不必等" in skill or "同回合再调" in skill
    assert "再带一层子队" in skill
    assert "二选一" in skill


def test_core_teaches_dependency_judgment_before_delegating():
    # depends_on 正反例 HOW 只留编排 skill；核心只留短判决 + 钩子。
    hint = _CEO_CORE_HINT
    assert "team_orchestration_advanced" in hint
    assert "正例" not in hint and "反例" not in hint  # 正反例不回胀核心
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "生产者→消费者" in skill or "下游是否要吃上游" in skill
    assert "depends_on" in skill
    assert "正例" in skill and "反例" in skill
    assert "全平铺" in skill or "平铺并行" in skill


def test_core_teaches_coordination_budget_awareness():
    # 协调预算数值下沉 skill；核心只钩子。
    from agentcore.runtime.coordination.session import (
        DEFAULT_COORDINATION_BUDGET,
        MAX_COORDINATION_BUDGET,
    )

    hint = _CEO_CORE_HINT
    assert "协调预算" in hint
    assert f"默认约 {DEFAULT_COORDINATION_BUDGET} 次" not in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "协调预算" in skill
    assert f"默认约 {DEFAULT_COORDINATION_BUDGET} 次" in skill
    assert f"上限 {MAX_COORDINATION_BUDGET} 次" in skill
    assert "量力" in skill or "里程碑" in skill


def test_core_teaches_cross_turn_append_routing_and_wording():
    # 跨回合 append HOW 只留编排 skill；核心钩子即可。
    hint = _CEO_CORE_HINT
    assert "跨回合" in hint
    assert "team_orchestration_advanced" in hint
    assert 'append_to_execution_id="latest"' not in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "【跨回合延续】" in skill
    assert 'append_to_execution_id="latest"' in skill
    assert "recent_team_graph" in skill
    assert "已追加、正在报到" in skill
    assert "在同一回合的同一张图里" in skill
    assert "自动降级" in skill or "已自动" in skill
    assert "硬失败再改口" in skill or "勿先硬失败" in skill

def test_skill_teaches_same_layer_pipeline():
    # A multi-stage pipeline is a DAG within ONE delegate call (depends_on, same
    # layer) — moved to team_orchestration_advanced (P3). The nesting axis
    # (delegation depth) lives in the same skill.
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "depends_on" in skill
    assert "同一层" in skill


def test_core_teaches_delegating_parallel_research():
    # C: deliverable-scale research that spans independent angles is TEAM work — the
    # CEO must fan it out to parallel research workers (which hold retrieval tools too),
    # not run all retrieval serially itself and delegate only the writing (the
    # 「调研收归 CEO 串行」 regression seen in the law conversation). Its own retrieval
    # stays for direct answers / light orientation (探路), not the deliverable's legwork.
    hint = _CEO_CORE_HINT
    assert "广度调查" in hint
    assert "探路" in hint
    assert "3" in hint and "轮" in hint
    assert "≥2 角" in hint or "继续开发" in hint


def test_core_forbids_silent_worker_count_discount():
    # 用户点名 N 个 worker 时不得静默缩成更少（trace 2f52c042: 点名盘点却派 7 调研员）。
    # 撞上限须分批追加或向用户明示取舍。
    hint = _CEO_CORE_HINT
    assert "静默打折" in hint
    assert "向用户明示" in hint


def test_core_teaches_one_heavy_task_per_worker():
    # 规划纪律：一个 worker 只派一件重活；多份独立文件类交付物拆给多员。
    hint = _CEO_CORE_HINT
    assert "一个 worker 只派一件重活" in hint
    assert "文件类交付物" in hint


def test_core_reminds_pass_hidden_context_to_worker():
    # A worker never sees the conversation history, so the CEO must write the
    # decision's key assumptions / constraints into the task itself.
    hint = _CEO_CORE_HINT
    assert "看不到" in hint
    assert "对话历史" in hint


def test_core_teaches_confirmed_constraints_block_on_delegate():
    """定稿漂移 A′：委派须固定「已确认约束」；有 ask 槽位写入、无卡亦枚举；约束优先于附件旧表。"""
    hint = _CEO_CORE_HINT
    assert "已确认约束" in hint
    assert "ask_user" in hint
    assert "自由文" in hint
    assert "意图分类" in hint  # 禁止自动抽
    assert "约束块优先" in hint or "优先" in hint
    assert "附件" in hint
    # 编排 skill 同口径
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "已确认约束" in skill
    assert "约束块优先" in skill or "优先" in skill


def test_shared_base_teaches_howto_stale_path_honesty():
    """howto 过时路径 A′：无现行可核 → 易变/待实测；覆盖零工具；收口≠伪精确菜单。"""
    from agentcore.runtime.resolve.prompt import _DEFAULT_SYSTEM_PROMPT

    assert "易变/待实测" in _DEFAULT_SYSTEM_PROMPT or "易变" in _DEFAULT_SYSTEM_PROMPT
    assert "待实测" in _DEFAULT_SYSTEM_PROMPT
    assert "零工具" in _DEFAULT_SYSTEM_PROMPT
    assert "逐步菜单" in _DEFAULT_SYSTEM_PROMPT or "逐步点击" in _DEFAULT_SYSTEM_PROMPT
    assert "现行可核" in _DEFAULT_SYSTEM_PROMPT
    assert "当日" in _DEFAULT_SYSTEM_PROMPT  # 明示不是机械日历门槛
    assert "摘要收口" in _DEFAULT_SYSTEM_PROMPT
    assert "伪精确" in _DEFAULT_SYSTEM_PROMPT
    # claim_evidence 旁对齐路径主张
    assert "后台路径" in _DEFAULT_SYSTEM_PROMPT or "逐步点击" in _DEFAULT_SYSTEM_PROMPT
    assert "<claim_evidence>" in _DEFAULT_SYSTEM_PROMPT


def test_skill_teaches_constraint_vs_solution_boundary():
    # 认知分工边界（约束 vs 方案）: the CEO writes requirements/constraints into the
    # task, but leaves the deliverable's professional STRUCTURE (a paper's chapters /
    # argument, a codebase's architecture) to the expert worker — unless the user
    # fixed it. Moved to team_orchestration_advanced (P3). Pins the fix for the
    # 「CEO 替专家把方案定死、worker 沦为填字员」regression (法律论文案例).
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "专业方案" in skill
    assert "填字员" in skill
    # 审查 / 评估类「指路不代答」：初审线索走便签，不写进 task 替答。
    assert "seed_notes" in skill and "heads_up" in skill
    assert "引导性问题" in skill or "风险预判" in skill
    assert "已确认约束" in skill


def test_core_teaches_delegate_point_dont_answer():
    # task 长教法下沉编排 skill；核心只留短钩子。
    hint = _CEO_CORE_HINT
    assert "目标·边界·验收" in hint
    assert "编排 skill" in hint or "team_orchestration_advanced" in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "施工图" in skill or "填字员" in skill
    assert "seed_notes" in skill and "heads_up" in skill
    assert "引导性问题" in skill or "风险预判" in skill


def test_core_teaches_execution_and_recall_routing():
    # 短指针：跑/修/打开验证终向靠提示词（对照 workspace）；引擎不扫用户文硬分叉。
    # 意图梯度：跑起来→CEO terminal 报 URL；右坞/浏览器才 navigate；验收才截图。
    hint = _CEO_CORE_HINT
    assert "【执行 / 运行 / 打开】" in hint
    assert "workspace_context" in hint
    assert "ask_user" in hint
    assert "test_run" in hint or "verify" in hint
    assert "意图梯度" in hint
    assert "跑起来" in hint and "报 URL" in hint
    assert "验证员" in hint
    assert "browser_navigate" in hint
    assert "右坞打开" in hint or "帮我看页面" in hint
    assert "验收" in hint and ("截图" in hint or "screenshot" in hint)
    assert "delegate" in hint
    assert "读文件" in hint or "列目录" in hint
    assert "冒充已跑或已验" in hint
    assert "不扫用户文" in hint or "硬分叉" in hint
    assert "已绑定本地工程" in hint or "跑当前项目" in hint
    # 不再叠长禁令散文
    assert "不要先读完口述" not in hint
    assert "禁止 DIRECT" not in hint
    assert "【回忆 / 核实产出】" in hint
    assert "口头拒绝" not in hint or "交付缺口" in hint


def test_core_teaches_repair_code_ui_verify_routing():
    """白屏/挂载复现 → verify= browser 形；勿默认全仓 tsc/pytest（提示词分流，非硬闸）."""
    hint = _CEO_CORE_HINT
    assert 'playbook="repair_code"' in hint
    assert "白屏" in hint or "挂载" in hint
    assert "browser" in hint
    assert "verify=" in hint
    assert "勿" in hint and ("tsc" in hint or "pytest" in hint)


def test_core_teaches_outline_checkpoint_prefers_structured_path():
    # 主拍板细则在 ask_user_*；核心一句钩子。
    hint = _CEO_CORE_HINT
    assert "主拍板" in hint
    assert "ask_user" in hint
    assert "checkpoint_after" not in hint
    assert "方案挑选" in hint or "风险确认" in hint or "短澄清" in hint


def test_core_worker_capability_follows_workspace_facts():
    # Prompt 事实对齐（能力闸门与交付诚实性）：不再宣称 worker「持全套工具」；以
    # <workspace_context> 的「本回合执行能力」行为准——code_execute=未装配 时 worker
    # 同样没有执行环境（能写文件、不能运行 / 生成二进制产物）。
    hint = _CEO_CORE_HINT
    assert "持全套工具" not in hint
    assert "本回合执行能力" in hint
    assert "code_execute=未装配" in hint
    assert "能写文件、不能运行" in hint


def test_core_teaches_delivery_honesty_when_no_execution():
    # 云端无执行环境：核心短钩子点复盘/落盘；交付缺口细节在编排 skill。
    hint = _CEO_CORE_HINT
    assert "ask_user" in hint
    assert "test_run" in hint or "verify" in hint
    assert "意图梯度" in hint
    assert "browser_navigate" in hint
    assert "验证员" in hint or "跑起来" in hint
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "未运行验证" in skill or "交付缺口" in skill
    assert "form=files" in skill


def test_core_teaches_delivery_path_by_workspace_type():
    # 收口信任级：产物出口按执行位置分道。
    hint = _CEO_CORE_HINT
    assert "【产物路径】" in hint
    assert "完整" in hint and "约定文档出口" in hint
    assert "裸" in hint or "reviews/" in hint
    # 午后巡 87de：交付下载给面板可用相对路径；404 须解释+列目录，禁闷声
    assert "交付下载·面板路径" in hint
    assert "下载失败" in hint or "404" in hint
    assert "file_list" in hint
    assert "闷声" in hint or "空泡" in hint
    assert "【交付指引】" in hint
    assert "执行位置分道" in hint
    assert "收口硬约束" in hint
    assert "文件」面板" in hint
    assert "完整预览" in hint
    assert "右坞「浏览器」" in hint or "右坞" in hint
    assert "【右坞浏览器】" in hint
    assert "browser_navigate" in hint
    assert "escalate" in hint
    assert "已登录，继续" in hint
    assert "用浏览器打开" in hint
    assert "navigate 成功即可" in hint or "帮我看页面" in hint
    assert "跑起来" in hint or "打开看一下" in hint  # 切断跑起来→必须 navigate
    assert "你自己" in hint  # CEO 直调 navigate
    assert "口头假验收" in hint or "已打开即可" in hint
    assert "delegate" in hint  # 验收仍 delegate
    assert "read_url" in hint
    assert "双击打开" in hint
    assert "系统浏览器" in hint
    assert "禁止给本机磁盘路径" in hint or "禁止给本机" in hint
    assert "真实路径" in hint
    # 缺能力 → 同轮可开工；人手一等；禁堆装配说明书
    assert "同轮可开工" in hint
    assert "手脑" in hint
    assert "假开页" in hint or "勿假装" in hint or "假开页底线" in hint
    assert "ask_user(browser_login=true)" in hint
    assert "escalate → 右坞接管" not in hint
    assert "仅可作标明" not in hint  # 旧：未装配只剩 read_url 摘录


def test_core_teaches_presentation_honesty():
    # 演讲/PPT/Office：诚实性钩子保留；场面 format_options 已退役。
    # 须真目标后缀；无执行禁再派跑脚本；当模板须 file_copy。
    # 案 5d25 / 08-08④：图形组织图直接拒+替代；仅文本/表格 Word；禁说满空派。
    hint = _CEO_CORE_HINT
    assert "pptx" in hint.lower()
    assert "Office 已落盘可直接使用" in hint or "PPT 已落盘可直接使用" in hint
    assert "静默" in hint or "只交" in hint
    assert "file_copy" in hint
    assert "当模板" in hint or "按模板" in hint
    assert "Presentation()" in hint
    assert "再派" in hint or "ask_user" in hint
    # 案 1eb5eb99 A：压体积与模板保真解耦（另存 slim / 列删改）
    assert "压体积" in hint and "模板保真" in hint
    assert "*_slim.pptx" in hint or "slim.pptx" in hint
    assert "相对模板" in hint
    assert "图形组织图" in hint
    assert "直接拒" in hint
    assert "文本" in hint and "表格" in hint
    assert "说满" in hint and "空派" in hint
    assert "SmartArt" not in hint and "DrawingML" not in hint
    kickoff = build_system_skill_registry().get("ask_user_kickoff").body
    # 场面 format_options 已退役；仅允许以「禁复活」语境出现，不得当字段教
    assert "复活" in kickoff and "format_options" in kickoff
    assert "style_options" not in kickoff
    orch = _TEAM_ORCHESTRATION_ADVANCED
    assert "python-pptx" in orch
    assert "代写全章节大纲" in orch or "Marp 语法" in orch
    assert "file_copy" in orch
    assert "当模板" in orch
    assert "Presentation()" in orch
    assert "再派" in orch and "跑脚本" in orch
    assert ".py" in orch and "不算" in orch
    assert "压体积" in orch and "模板保真" in orch
    assert "*_slim.pptx" in orch or "slim.pptx" in orch
    assert "图形组织图" in orch
    assert "说满" in orch and "空派" in orch


def test_core_teaches_required_sections_same_literal():
    """案 f9a6 / 08-08②：派活钉必备章节同字面；禁对用户藏裸报错。"""
    hint = _CEO_CORE_HINT
    assert "required_sections" in hint
    assert "同字面" in hint or "同一套原文" in hint
    assert "近义" in hint
    assert "裸报错" in hint or "藏契约" in hint
    orch = _TEAM_ORCHESTRATION_ADVANCED
    assert "同字面" in orch or "同一套原文" in orch
    assert "裸报错" in orch or "藏起契约" in orch or "藏契约" in orch


def test_core_teaches_short_edit_not_m2a_kickoff_template():
    """案 7e9d2d4b：短改稿禁套任务卡开工模板（提示/结构字段，非意图分类器）。"""
    hint = _CEO_CORE_HINT
    assert "短改稿" in hint
    assert "任务卡" in hint
    assert "开工模板" in hint or "规格已冻结" in hint
    assert "扫长文猜意图" in hint or "禁止扫" in hint
    assert "M2A" not in hint  # 原则复用，不绑死单编号族


def test_core_teaches_explicit_confirm_before_disk_write():
    """案 79789150：明示确认后再落盘 → ask_user(blocking)+default；禁扫全文猜意图。"""
    hint = _CEO_CORE_HINT
    assert "明示确认后再落盘" in hint
    assert "确认后再落盘" in hint or "先对齐再写" in hint
    assert "ask_user" in hint and "blocking" in hint
    assert "default" in hint
    assert "扫全文猜意图" in hint


def test_shared_base_and_core_teach_windows_bat_crlf_ascii():
    """案 261bfc46 A：Windows .bat → CRLF+ASCII 或改 ps1；禁写盘自动转码。"""
    from agentcore.runtime.resolve.prompt import _DEFAULT_SYSTEM_PROMPT

    base = _DEFAULT_SYSTEM_PROMPT
    assert "Windows" in base and ".bat" in base
    assert "CRLF" in base
    assert "ASCII" in base
    assert ".ps1" in base
    assert "不" in base and ("转码" in base or "改换行" in base)
    hint = _CEO_CORE_HINT
    assert ".bat" in hint
    assert "CRLF" in hint
    assert "双击即用" in hint
    assert "自动转码" in hint
    orch = _TEAM_ORCHESTRATION_ADVANCED
    assert ".bat" in orch and "CRLF" in orch
    assert "ASCII" in orch
    assert ".ps1" in orch
    assert "双击即用" in orch


def test_core_teaches_image_gen_egress_and_key_boundary():
    """案 20260803-image-gen-byok-egress-boundary A+B：无 egress 禁代调出图；Key 不落盘。"""
    hint = _CEO_CORE_HINT
    assert "生图" in hint
    assert "代调" in hint or "出图" in hint
    assert "API Key" in hint or "明文" in hint
    assert "本机脚本" in hint or "只帮写" in hint
    # 案 47ae：跨会话进度摘要禁回显密码/token（扩既有 Key 族，非新硬闸）
    assert "跨会话凭据脱敏" in hint
    assert "密码" in hint and "原会话" in hint
    orch = _TEAM_ORCHESTRATION_ADVANCED
    assert "生图" in orch
    assert "出站网络" in orch or "egress" in orch.lower() or "HTTPS" in orch
    assert "明文" in orch or "env" in orch
    assert "跨会话凭据脱敏" in orch


def test_core_teaches_cloud_web_install_verify_honesty():
    """案 20260803-cloud-web-install-deny-claim-verified A：云端不能装包时禁称跑绿。"""
    hint = _CEO_CORE_HINT
    assert "云端装包" in hint or "绿场 Web" in hint
    assert "自检全过" in hint
    assert "跑绿" in hint
    assert "单测已绿" in hint
    assert "export_to_local" in hint
    # 案 88625：记分板 N/N OK 须对齐成功 test_run（提示轻补，不扩姿势 A）
    assert "外环验绿对账" in hint
    assert "test_run" in hint
    assert "N/N OK" in hint or "passed" in hint
    # 与生图 / Office / 软Ⅱ′分轴提示仍在邻近段落
    assert "分轴" in hint or "零写盘" in hint


def test_core_teaches_short_clarify_not_scene_ledger():
    hint = _CEO_CORE_HINT
    assert "短问" in hint or "短澄清" in hint
    assert "提案墙" in hint
    kickoff = build_system_skill_registry().get("ask_user_kickoff").body
    assert "短问" in kickoff or "短澄清" in kickoff
    assert "开工提案卡" not in kickoff
    assert "禁止" in kickoff and "一键开做" in kickoff


def test_skill_teaches_environment_capability_constraint():
    # 编排 skill：无执行环境时改交付形态、显式标缺口（S3：无 kind 硬拒文案）。
    # 轻对齐：跑/验终向靠提示词对照 workspace（引擎不扫用户文硬分叉）。
    skill = _TEAM_ORCHESTRATION_ADVANCED
    assert "环境能力约束" in skill
    assert "code_execute=未装配" in skill
    assert "交付缺口" in skill
    assert "bind_local_folder" in skill  # 本机传统可教仍点名
    assert "导入到云" in skill or "连接 Git" in skill
    assert "合法非默认" in skill or "非默认" in skill or "本机传统" in skill
    assert "ask_user" in skill
    assert "form=files" in skill
    assert "能力策略收口" not in skill


def test_shared_base_teaches_delivery_baseline():
    # B3 一期：共享基座前置「交付底线」（围栏闭合 + #rN ∈ 台账 + 交付验收对照）。
    from agentcore.runtime.resolve.prompt import _DEFAULT_SYSTEM_PROMPT

    assert "<delivery_baseline>" in _DEFAULT_SYSTEM_PROMPT
    assert "成稿可引用集" in _DEFAULT_SYSTEM_PROMPT or "deep_read" in _DEFAULT_SYSTEM_PROMPT
    assert "出处" in _DEFAULT_SYSTEM_PROMPT
    assert "围栏必须成对闭合" in _DEFAULT_SYSTEM_PROMPT
    assert "#rN" in _DEFAULT_SYSTEM_PROMPT
    assert "真假引擎查" in _DEFAULT_SYSTEM_PROMPT
    assert "搜到" in _DEFAULT_SYSTEM_PROMPT and "可挂来源号" in _DEFAULT_SYSTEM_PROMPT
    assert "read_url" in _DEFAULT_SYSTEM_PROMPT  # 成稿挂号须先深读
    assert "交付验收对照" in _DEFAULT_SYSTEM_PROMPT
    assert "禁口头验收" in _DEFAULT_SYSTEM_PROMPT
    assert "只读口径" in _DEFAULT_SYSTEM_PROMPT
    assert "通过验收" in _DEFAULT_SYSTEM_PROMPT
    assert "全程只读" in _DEFAULT_SYSTEM_PROMPT
    assert "可用性短问" in _DEFAULT_SYSTEM_PROMPT
    assert "已完整可用" in _DEFAULT_SYSTEM_PROMPT


def test_shared_base_teaches_claim_evidence_soft_constraint():
    # 引用即出处 P3：调研成稿主张须证（prompt 软约束；无机械闸、不强迫辩词二分）。
    from agentcore.runtime.resolve.prompt import _DEFAULT_SYSTEM_PROMPT

    assert "<claim_evidence>" in _DEFAULT_SYSTEM_PROMPT
    assert "主张须证" in _DEFAULT_SYSTEM_PROMPT
    assert "暂靠提醒" in _DEFAULT_SYSTEM_PROMPT
    assert "待核实" in _DEFAULT_SYSTEM_PROMPT
    assert "#r1" in _DEFAULT_SYSTEM_PROMPT or "#rN" in _DEFAULT_SYSTEM_PROMPT
    assert "不强迫" in _DEFAULT_SYSTEM_PROMPT
    assert "【已核实" in _DEFAULT_SYSTEM_PROMPT  # 明示勿强迫辩词二分
    assert "search-only" in _DEFAULT_SYSTEM_PROMPT or "文字概括" in _DEFAULT_SYSTEM_PROMPT


def test_shared_base_teaches_work_authority():
    # 全局工作纪律：权威序 + 冲突通道 + 决策权限（CEO+worker 共享，极短）。
    from agentcore.runtime.resolve.prompt import _DEFAULT_SYSTEM_PROMPT

    assert "<work_authority>" in _DEFAULT_SYSTEM_PROMPT
    assert "用户规则硬胜" in _DEFAULT_SYSTEM_PROMPT
    assert "不自动升权威" in _DEFAULT_SYSTEM_PROMPT
    assert "escalate" in _DEFAULT_SYSTEM_PROMPT
    assert "ask_user" in _DEFAULT_SYSTEM_PROMPT
    assert "禁静默改权威稿" in _DEFAULT_SYSTEM_PROMPT
    assert "扩范围" in _DEFAULT_SYSTEM_PROMPT
    # 当前课题：工作区 ＞ 全局「正在做 X」
    assert "当前课题" in _DEFAULT_SYSTEM_PROMPT
    assert "工作区" in _DEFAULT_SYSTEM_PROMPT
    assert "正在做" in _DEFAULT_SYSTEM_PROMPT


def test_ceo_core_workspace_outranks_global_current_project_memory():
    """继续项目 / 汇报现状：工作区优先于全局画像「正在做 X」。"""
    hint = _CEO_CORE_HINT
    assert "【继续项目 / 汇报现状】" in hint
    assert "跟工作区" in hint
    assert "上一题残留" in hint
    assert "ask_user" in hint
    assert "旧项目名" in hint
    # CEO 增量钩：权威线索 / 未定案窄义 / 禁为读规则再派；HOW 在 work_discipline。
    hint = _CEO_CORE_HINT
    assert "权威线索" in hint
    assert "未定案·窄" in hint
    assert "读全局规则" in hint
    assert "work_discipline" in hint
    assert "问还是派·中性" in hint


def test_ceo_core_teaches_empty_shell_dual_project_kickoff():
    """空壳/双项目 kickoff：只读跨桌摸底、写仍派工换桌、≠挂载冒充。"""
    hint = _CEO_CORE_HINT
    assert "【跨项目 / 空壳 kickoff】" in hint
    assert "list_project_dir" in hint and "read_project_file" in hint
    assert "只读跨桌" in hint
    assert "出生桌" in hint
    assert "云端读不到本地" in hint and "禁止" in hint
    assert "target_folder_id" in hint
    assert "写仍派工换桌" in hint
    assert "file_list" in hint
    assert "external_mount_readonly" in hint
    assert "开发双仓" in hint or "乱挂" in hint or "冒充" in hint
    assert "不可" in hint and ("跳过" in hint or "≥2" in hint)
    # 一句短指针（HOW 在 skill；禁双写长段）
    assert "先建齐再同次派" in hint or "先建齐" in hint
    assert "拒后禁塌缩" in hint
    assert "team_orchestration_advanced" in hint and "跨项目并行指挥" in hint


def test_core_guides_out_of_workspace_absolute_paths():
    # 区外路径：对照 workspace_context 能力行；仅桌面已装配才挂载/整理；操作手册在 ask_user_*。
    hint = _CEO_CORE_HINT
    assert "工作区外" in hint
    assert "workspace_context" in hint
    assert "external_mount_readonly" in hint
    assert "grant_organize_folder" in hint
    assert "ask_user" in hint
    # 只读禁新发 grant_readonly 卡；整理仍确认。
    assert "禁止" in hint and "grant_readonly_folder" in hint
    # 授权后发现：带 well_known；模糊指代禁首轮要文件名。
    assert "授权后发现" in hint
    assert "well_known" in hint
    assert "禁止" in hint and "文件名" in hint
    # 口头同意闭环 + 歧义 2～3 候选 + 失败分型（提示面；禁空心等待）。
    assert "口头同意" in hint
    assert "等待确认" in hint and "禁止" in hint
    assert "2～3" in hint or "2-3" in hint
    assert "失败分型" in hint
    assert "没找着" in hint
    # 不得无条件鼓动「立即发卡」——本机 Host/区外叙述只留在 workspace_context。
    assert "立即发卡" not in hint
    mid = build_system_skill_registry().get("ask_user_midtask")
    assert mid is not None
    assert "external_mount_readonly" in mid.body or "区外目录" in mid.body
    assert "organize_plan" in mid.body
    assert "授权后发现" in mid.body
    assert "well_known" in mid.body
    assert "禁止" in mid.body and "文件名" in mid.body
    assert "选择器兜底" not in mid.body
    assert "grant_readonly_folder" in mid.body  # 禁新发叙事仍点名旧 action
    assert "禁止" in mid.body and "grant_readonly_folder" in mid.body
    assert "口头同意" in mid.body
    assert "2～3" in mid.body or "2-3" in mid.body
    assert "失败分型" in mid.body
    assert "单 choice" in mid.body  # 目标已明确仍可单卡；歧义才 2～3


def test_core_teaches_narrowed_attachment_scope_must_start():
    # 定案 A：用户收窄为本轮附件/工作区已有产物时须先动手；与 open_local_project 正交。
    hint = _CEO_CORE_HINT
    assert "本轮材料收窄" in hint
    assert "先这些" in hint or "就这些" in hint
    assert "缺口分析" in hint or "改一版" in hint
    assert "禁止整轮" in hint and ("催" in hint or "完整源码" in hint)
    assert "单点缺件" in hint or "局限" in hint
    assert "open_local_project" in hint
    assert "退役" in hint or "收窄本轮输入" in hint
    assert "开工前置" in hint
    # 案 adsense-zip-resident-missing B + AI_NOISE 假空：只认结构化缺件，禁用 list 当 oracle。
    assert "附件驻留·缺件" in hint
    assert "[resident missing]" in hint
    assert "重传" in hint
    assert "解压" in hint or "整改" in hint
    assert "ask_user" in hint
    assert "file_list" in hint  # 须点名禁止，不是教用它验盘
    assert "推断" in hint or "≠ 缺件" in hint or "浏览过滤" in hint
    assert "[binary]" in hint and "≠ 缺件" in hint
    # 禁止旧契约：用 file_list/exists「证实」路径不在当缺件触发条件。
    assert "file_list / exists 证实" not in hint
    assert "exists 证实" not in hint
    mid = build_system_skill_registry().get("ask_user_midtask")
    assert mid is not None
    assert "先读材料" in mid.body or "收窄本轮" in mid.body
    assert "开工前置" in mid.body


def test_core_points_to_consult_skill_and_directory():
    # 提示词瘦身 P2: the slim core must point the CEO at consult_skill + the 能力目录
    # so it knows the advanced「怎么做」guidance is pull-on-demand, not missing.
    hint = _CEO_CORE_HINT
    assert "consult_skill" in hint
    assert "能力目录" in hint


def test_core_drops_advanced_mechanism_detail():
    # Regression guard for P2: the rarely-used machinery now lives in system Skills,
    # so its DETAIL must not creep back into the always-on core (that would re-inflate
    # the per-turn prompt). These tokens are unique to the moved-out skill bodies.
    hint = _CEO_CORE_HINT
    for token in ("多轮辩论", "跨轮", "stance", "采纳正方", "checkpoint_after", "target_run_id"):
        assert token not in hint, f"advanced detail '{token}' leaked back into the core"


def test_citation_hint_teaches_multi_source_anchoring():
    # When several sources back one claim, the CEO anchors all of them (#r1#r2).
    hint = CHAT_CITATION_HINT
    assert "一并标注" in hint
    assert "#r1#r2" in hint


def test_citation_hint_teaches_claim_evidence_and_summary_inheritance():
    # CEO citing 段：挂号纪律 + 汇总继承；主张须证在共享基座；核心不第三遍重复。
    hint = CHAT_CITATION_HINT
    assert "挂号纪律" in hint
    assert "搜到" in hint and "可挂" in hint
    assert "read_url" in hint
    assert "汇总继承" in hint
    assert "重新编号" in hint
    assert "主张须证" not in hint  # 不归 citing 段
    from agentcore.runtime.resolve.prompt import _DEFAULT_SYSTEM_PROMPT

    assert "主张须证" in _DEFAULT_SYSTEM_PROMPT
    assert "综述若继承队员" not in _CEO_CORE_HINT  # 核心删第三遍


def test_memory_rules_fence_blocks_routing_by_topic_preference():
    """M1 教法围栏：长期记忆不得改变本回合路由——只留记忆模板。"""
    out = assemble_system_prompt(memory_markdown="- 用中文\n- 偏好法律分析\n")
    assert "<rules>" in out
    assert "沟通方式与已知事实" in out
    assert "不得改变本回合路由" in out
    assert "直答/委派/调研/辩论以用户当前话为准" in out


def test_ceo_core_teaches_memory_must_not_override_routing():
    """M1：核心不再双写记忆路由围栏（唯一所有者=记忆模板）。"""
    hint = _CEO_CORE_HINT
    assert "长期记忆与路由" not in hint
    assert "不得改变本回合" not in hint


def test_ceo_core_teaches_memory_history_user_facing_framing():
    """记忆/历史：对外白话 + 须说明派人查找，禁止装不知道。"""
    hint = _CEO_CORE_HINT
    assert "记忆/历史·对外口径" in hint
    assert "跨会话原文" in hint
    assert "派队员" in hint
    assert "装不知道" in hint
    assert "禁止报工具名" in hint or "禁止报工具名与内部角色名" in hint
    assert "画像细节" in hint


def test_ceo_core_teaches_user_rules_framing():
    """用户规则：对外可记/改/删；内部改/删走 remember；禁只追加却声称已替换。"""
    hint = _CEO_CORE_HINT
    assert "用户规则·对外口径" in hint
    assert "用户规则·内部" in hint
    assert "可增" in hint and "可改" in hint and "可删" in hint
    assert "remember" in hint
    assert "只追加却声称" in hint
    assert "文件页规则本" in hint
    assert "硬约束清单" in hint
    # 对外段不堆 ENUM；action 名只在内部段
    external = hint.split("【用户规则·对外口径】", 1)[1].split("【", 1)[0]
    assert "action=" not in external
    assert "replace" not in external and "forget" not in external


def test_ceo_core_platform_knowledge_two_way_routing():
    """平台知识两分：机制走系统提示+workspace；怎么用走 product_help；禁外搜/翻仓当手册。"""
    hint = _CEO_CORE_HINT
    assert "<platform_knowledge>" in hint and "</platform_knowledge>" in hint
    block = hint.split("<platform_knowledge>", 1)[1].split("</platform_knowledge>", 1)[0]
    # 常驻产品面地图短：品类 + 高频入口 + 两分路由 + 规则载体对照短钩，勿膨胀整本手册
    assert len(block.strip().splitlines()) <= 30
    assert "【品类】" in block
    assert "【产品面地图·高频入口】" in block
    assert "【两分路由】" in block
    assert "机制" in block and "架构" in block and "记忆" in block and "能力边界" in block
    assert "系统提示" in block and "workspace_context" in block
    assert "怎么用" in block or "功能介绍" in block
    assert "consult_skill(product_help)" in block
    assert "product_help_map" in block and "product_help_faq" in block
    assert "web_search" in block
    assert "工作区" in block and ("产品说明" in block or "平台手册" in block or "平台文档" in block)
    # 产品本身 Bug 分流一句（非整份 HOW）
    assert "consult_skill(product_bug_triage)" in block
    assert "可证伪故障" in block
    assert "四类结论" not in block
    assert "复现要点" not in block
    # 跨产品规则范式：载体对照短钩（≠.mdc / ≠skills JSON；迁移先查 product_help）
    assert "【用户规则·载体对照】" in block
    assert "AgentCore/规则/" in block
    assert "remember" in block
    assert ".mdc" in block
    assert "skills/*.json" in block
    assert "Cursor" in block and "AgentCore" in block


def test_ceo_core_cross_product_rule_paradigm_routing_hook():
    """问还是派附近：跨产品规则范式窄钩——consult 后至多一次 list，仍不清再短问；禁默迁 skill JSON。"""
    hint = _CEO_CORE_HINT
    assert "【跨产品规则范式】" in hint
    # 紧挨「问还是派·中性」之后（路由窄钩，非 platform_knowledge HOW）
    ask_or_delegate = hint.split("【问还是派·中性】", 1)[1]
    assert ask_or_delegate.index("【跨产品规则范式】") < ask_or_delegate.index(
        "【决策/澄清短问·default】"
    )
    paradigm = ask_or_delegate.split("【跨产品规则范式】", 1)[1].split(
        "【决策/澄清短问·default】", 1
    )[0]
    assert "未钉死目标载体" in paradigm
    assert "consult_skill(product_help)" in paradigm
    assert "ask_user" in paradigm
    assert "至多一次窄 list `.cursor/rules`" in paradigm
    assert "多轮 list / 通读 `.mdc`" in paradigm
    assert "AgentCore/规则/" in paradigm
    assert "只解释不动文件" in paradigm
    assert "default" in paradigm
    assert "skills/*.json" in paradigm
    assert "平台规则" in paradigm
    assert "delegate" in paradigm
    assert ".mdc" in paradigm and "skill JSON" in paradigm
    assert "扫自由文" in paradigm and "猜意图" in paradigm
    assert "硬闸" in paradigm
    # 禁大段 HOW 常驻（细则在 skill）
    assert "细则在 skill" in paradigm
    assert "意图分类器" not in paradigm


def test_ceo_core_teaches_intent_routing_for_adversarial_entry():
    """对抗入口极短路口牌；细则在 skill。"""
    hint = _CEO_CORE_HINT
    assert "debate_and_review" in hint
    assert "deep_multi_lens_research" in hint
    assert "legal" in hint.lower() or "自搜" in hint
    # 长教法不在核心
    assert "MLR → 命题卡 → 推进卡" not in hint
    assert "庭前取证由辩论机制保证" not in hint


def test_ceo_prompt_with_legal_pack_keeps_intent_adversarial_routing():
    """回归钉：含 legal 包时 CEO 系统提示仍可路由对抗入口（核心短牌 + 目录）。"""
    from agentcore.runtime.skills import MULTI_LENS_COURTROOM_TRIGGERS, render_skill_directory

    reg = build_system_skill_registry(include_legal=True)
    tools = {"delegate", "debate", "ask_user", "consult_skill", "web_search", "consult_memory"}
    ceo = compose_ceo_chat_prompt(
        assemble_system_prompt(),
        skill_registry=reg,
        ceo_tool_names=tools,
    )
    assert ceo.count("<能力目录>") == 1 and ceo.count("</能力目录>") == 1
    assert "<role>" in ceo and "</role>" in ceo
    assert "<how_you_work>" in ceo and "</how_you_work>" in ceo
    directory = render_skill_directory(reg, tools)
    assert "deep_multi_lens_research" in directory
    assert "debate_and_review" in directory
    deep_line = next(
        line for line in directory.splitlines() if line.startswith("- deep_multi_lens_research：")
    )
    debate_line = next(
        line for line in directory.splitlines() if line.startswith("- debate_and_review：")
    )
    assert any(t in deep_line for t in MULTI_LENS_COURTROOM_TRIGGERS)
    assert "debate_and_review" in deep_line
    assert "deep_multi_lens_research" in debate_line
    assert "deep_multi_lens_research" in ceo
    assert "debate_and_review" in ceo
    assert "对抗入口" in _CEO_CORE_HINT or "点名开辩" in _CEO_CORE_HINT
