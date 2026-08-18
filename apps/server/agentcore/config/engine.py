"""ReAct engine loop: timeouts, governance, tool-clear, finish-guard."""

from pydantic import BaseModel


class EngineSettings(BaseModel):
    tool_default_timeout_seconds: float = 60.0
    tool_execution_timeout_seconds: float = 90.0

    engine_empty_response_threshold: int = 2

    # R-04 收敛治理参数化：滑窗卡死检测的窗口大小（回落 loop_controller
    # DEFAULT_WINDOW=8）。同参/交替失败在窗内计数达 engine_unproductive_threshold
    # → NUDGE，再触发 → FINALIZE。
    engine_loop_window: int = 8
    # R-04/R-02 检索预算·搜索池（web_search per-run 槽位；回落
    # retrieval_budget.DEFAULT_RETRIEVAL_BUDGET=14）。≤0 → 卸 web_search。
    # R-02 起搜/读分池：read_url 走独立读池（见 engine_retrieval_read_budget），
    # 不再与搜索池共用一个额度。
    engine_retrieval_budget: int = 14
    # R-02 检索预算·读池（read_url 深读，按「页」计量，页 = retrieval_budget.READ_PAGE_CHARS
    # 字符）。回落与搜索池同值 14 页（约 3.5 次 8000 字全文深读）。≤0 → 卸 read_url。
    engine_retrieval_read_budget: int = 14
    # R-03 前缀缓存观测（审计 D4，observability/prefix_cache.py）：观测已常驻（每
    # llm.call 一条 cost.prefix_cache 探针），默认 debug 级不落 jsonl（长会话避免挤掉
    # llm.call 的 20MB×5 窗口）。置 True → 提升为 info 落盘，无需全局 LOG_LEVEL=DEBUG，
    # 便于按需积累 D4 数据后再动装配结构。
    engine_prefix_cache_observability: bool = False

    engine_tool_failure_warn: int = 2
    engine_tool_failure_disable: int = 3
    engine_unproductive_threshold: int = 3
    # CEO 探路硬上限（team_gate，captain-only、每 run 一次）：达此 **探路轮** 数即收回
    # 调查类工具，逼 delegate 或短答。同轮并行多工具只计 1 轮；一轮内所有调查调用
    # 全失败（幻觉路径等）不计——那一轮没换到任何情报，不该扣广度预算。
    # 数字唯一真源：提示词文案与文档都跟这里，禁止各处硬编码。
    # 默认 7（原 5）：实测触发时模型每轮并行 2–3 次调用，5 轮≈10–16 次读，但 3/3 触发
    # 都有整轮花在不存在的路径上；补上被幻觉路径吃掉的余量。抬得更高会放大 CEO
    # 单干塌缩面（成规模审计恰恰该早派）。
    engine_team_gate_investigation_rounds: int = 7
    # 调查满 N 轮强制收工已退役：create_loop_controller 永远把
    # convergence_finalize_rounds 设为 0，即便本项 >0 也忽略，防止
    # 环境变量把误设计救活。读很多轮不同内容不是空转。
    # 同一目标连读仍走 engine_convergence_spin_rounds → FINALIZE。
    # 计数器与 LoopController 显式传入 finalize_rounds 仍可用；默认 0。
    engine_convergence_finalize_rounds: int = 0
    # Consecutive investigation-only rounds re-reading the same targets before finalize.
    engine_convergence_spin_rounds: int = 3
    # 交文件空转（久读无写催写 / 收检索）已退役：create_loop_controller 对
    # files_expected 永不打开 nudge/narrow/report，即便本项 >0 也忽略，防止
    # 环境变量把误设计救活。计数器与 LoopController 显式构造仍可用；默认 0。
    # 与 token/timeout wind_down 无关（那是额度将尽，不是「没写过文件」）。
    engine_delivery_idle_nudge_rounds: int = 0
    engine_delivery_idle_narrow_rounds: int = 0
    # 非交文件（调查/诊断）队员：久读无结论只 soft nudge，不收窄工具、不 FINALIZE。
    # 与 delivery_idle 共用纯调查轮计数器；文案催 handoff/escalate/收敛，不催写盘。
    # ≤0 关闭。默认 8：给一次刹车（不依赖已退役的调查轮绝对顶）。
    engine_recon_idle_nudge_rounds: int = 8
    engine_finish_guard_max_reworks: int = 2
    # C2 概览契约：本回合已发 delivery_status 时，CEO 终稿超过此字数 → finish_guard 回炉压缩。
    # 细节已在交付卡 / 产物卡 / run 详情；气泡只做索引。≤0 关闭。无交付卡的 prose 回合不设顶。
    engine_ceo_overview_max_chars: int = 1000

    # Captain (CEO) ReAct ceiling — higher than chat default (16) because coordination
    # mode (team events, synthesis, follow-up delegate for audit/revision) burns rounds.
    # Workers use the single agent profile; 0 = inherit chat profile unchanged.
    engine_captain_max_rounds: int = 24

    # 委派并发预算：ONE knob for (a) root CEO fan-out ContextVar shares（分而不乘 —
    # see runs/concurrency.py）and (b) a single WaveScheduler's dispatch width
    # (runs/wave.py). Nested delegate (depth≥1) reseeds this full value per sub-team
    # (各嵌套满额；spawn 仍受 MAX_WORKER_SUBDELEGATIONS). Overflow queues (bounds
    # latency, not team size). 12 非上游硬限——F9 中转限速已实测通过（2026-07-20
    # 运营方确认无虞），余量收紧或想再放宽时直接改此值（内测计费翻转后上游走合作
    # 中转，旧「本机是唯一约束、远低于 DeepSeek 单账号并发」的标定已过时）。runs
    # 包读它走延迟解析（settings 不可用时回落到
    # runs/constants.py::MAX_PARALLEL_DELEGATIONS，值同步为 12）。
    engine_max_parallel_delegations: int = 12

    # R-05 晚绑定波边界等待 CEO 定稿的墙钟超时（秒）。None / 0 = 不启用（保持现状：
    # BIND 边界 YIELD 后无限等待 CEO replan 定稿）。>0 时：同一 ``bind_after_deps`` 节点
    # 自首次进入 BIND 边界起超过该时长仍未定稿 → 自动落单（清 ``bind_after_deps`` 标记、
    # 按普通节点调度，不再等 CEO），并记 ``wave.bind_auto_finalise_timeout`` warning——
    # 兜住协调模式下 CEO 波内缺席 / 掉线 / 未理解 BOUNDARY_YIELD 导致的波边界悬停。
    # 经典模式的用户拍板语义（checkpoint plan_review）不受影响：本兜底只作用于「CEO 定稿」
    # 的晚绑定节点，且默认关闭。计时挂在 RunSpec.bind_boundary_since（跨 YIELD/resume 持久，
    # 计划复用不丢）。
    engine_wave_bind_boundary_timeout_seconds: float | None = None

    # 当轮调查结果（NEVER + FILESYSTEM/SEARCH/RESEARCH）投影窗：只留最近 N 条
    # ≥min_chars 的全文。journal / UI 仍全文。旧结果 → 稳定指针；file_read 另附
    # ≤1200 字结构摘要 + 再读授额。2 打堆叠税（工人长调查把多份读窗整段
    # 带进下一轮 LLM）；不拧单次安全顶、不把 file_read 塞回通用 4k 头尾裁
    # （那伤单次读手感）。host_shell / terminal 走独立 exec 窗，不进本集合。
    engine_tool_clear_keep_recent: int = 2
    engine_tool_clear_min_chars: int = 2000
    # R-09 按工具差异化投影窗：{tool_name: keep_recent}，覆盖全局
    # engine_tool_clear_keep_recent。空 = 全部调查工具共享全局窗（现状，行为不变）。
    # 例：{"read_url": 1} 让网页抓取结果只留最近 1 条全文（read_url 常为大 HTML，token
    # 大户），file_read 等仍按全局窗。exec 窗（engine_tool_clear_exec_keep_recent）
    # 独立、不受本映射影响。
    engine_tool_clear_keep_recent_by_tool: dict[str, int] = {}
    # host_shell / terminal 当轮 stdout 独立投影窗（不进 investigation_tools，
    # 以免改空转治理）。指针禁止教重跑。1 = 只留最近一条全文。code_execute /
    # test_run 不在此列（改码对照 / 验证诚实性）。
    engine_tool_clear_exec_keep_recent: int = 1
    # R1: when clearing a large file_read result, append a deterministic structural
    # digest (chars). 0 = pointer-only rollback (no summary). Must keep
    # pointer+summary strictly below engine_tool_clear_min_chars (idempotency).
    engine_tool_clear_file_read_summary_max_chars: int = 1200
    # R1: when a path has zero verbatim file_read bodies left in the projected
    # window, grant this many sticky extra successful full-reads beyond
    # FILE_READ_SAME_PATH_MAX (per path per run sticky issue; write success may
    # refresh via refresh_file_read_reread_grant). Cleared paths are not hard-
    # rejected when grant is exhausted. 0 = disable sticky grant (hard cap only
    # while verbatim still present).
    engine_file_read_reread_grant: int = 1
    # C3 较强文件归属：True = 协调会话级归属表（声明即占、完成后仍占、写时互斥含
    # str_replace/write_section）。False = 回滚「仅未完成启发式 overlap + 批内
    # write/append claim」。
    engine_file_ownership_v2: bool = True

    # Worker 累计 token 硬顶 (loose backstop): compaction (tool_clear) 挑大梁做
    # 上下文瘦身,这只是防失控的安全阀。每轮末比对累计 input+output tokens,到顶即收口。
    # 经 ``apply_worker_budgets`` 统一回填到各 worker；CEO 显式 ``token_ceiling`` 优先。
    # ≤0 关闭 (CEO/solo 路径不传此上限,保持 0)。
    engine_worker_token_ceiling: int = 4_000_000
    # 用户回合 turn 级累计 token 硬顶（CEO + 全树 worker，含续派）：触顶后禁新
    # delegate / debate / 新波派发，在飞跑完不 cancel。与 per-worker 顶正交。≤0 关闭。
    # 默认 30M：对齐「用户认可多路嵌套」的全仓级专班尽量一回合跑完（dogfood 全仓
    # AI 审计全树 input≈27M 仍未收完）；多路嵌套预占与收尾留余量。
    engine_turn_token_ceiling: int = 30_000_000
    # 嵌套子团队（depth≥1）准入拨付信封：开工时从父剩余原子预留
    # min(本值, 父剩余)；子 DAG 波内只看信封触顶，中途不以父顶砍子尾。
    # 消耗仍计入回合总量。≤0 关闭并回退「全树共父顶」现状。
    # 默认 8M：单路嵌套略放宽；三路同时预占仍依赖父 turn 顶（约 24M+ 父已耗）。
    engine_nested_turn_token_ceiling: int = 8_000_000
    # Turn 交付预留（对齐 worker wind_down）：spent ≥ ceiling − reserve 时只放行
    # ``ceiling_priority`` 节点（如 build_website QA），未开跑的次要节点软跳过以便依赖汇合。
    # 默认 400k（够一次 QA/目验；不随 worker 顶同步抬）；≤0 或
    # reserve ≥ ceiling 关闭预留软闸（硬顶仍在）。
    engine_turn_token_delivery_reserve: int = 400_000
    # R-01 回合级 LLM 聚合成本护栏（费用硬顶，整数 nano-CNY）：与 token 顶正交，
    # 计量的是「已计价 billable 费用」（platform/vendor 的 cost_total_nano；BYOK 估计值
    # 单独累计、不入顶）。触顶后禁新 delegate/debate/新波派发，在飞跑完不 cancel。
    # ≤0 关闭。默认 0（关）——成本顶需按部署计费档位标定后再放开，避免误伤长任务；
    # 语义与 engine_turn_token_ceiling 完全对齐（软闸→硬顶两段式降级）。
    engine_turn_cost_ceiling_nano: int = 0
    # R-01 成本交付预留（对齐 engine_turn_token_delivery_reserve）：累计 billable 费用
    # ≥ ceiling − reserve 时只放行 ``ceiling_priority`` 节点，次要节点软跳过。≤0 或
    # reserve ≥ ceiling 关闭成本软闸（成本硬顶仍在）。
    engine_turn_cost_delivery_reserve_nano: int = 0
    # 预算收尾窗口：累计 token ≥ ceiling − reserve 时强制进入落盘/handoff-only 轮，
    # 降低硬顶后 degraded_synth。收尾需要的空间是绝对量（成篇落盘一次就是上万
    # token），不该随 ceiling 缩放；比例制在低 ceiling 下留量过薄、实测触顶超标。
    # ≤0 关闭软窗（只留硬顶）；reserve ≥ ceiling 视为病态配置，同样关闭软窗。
    engine_worker_token_wind_down_reserve: int = 30_000
    # 墙钟超时两段式：先在 threshold × ratio 处警告 worker「限一轮内交接」，
    # 再到硬阈值才向 CEO 发 TIMEOUT 通知（仍不自动取消）。须 ∈ (0, 1)；≤0 关闭预警。
    engine_worker_timeout_warn_ratio: float = 0.75

    # 流式停滞闸 (卡死根因): a per-chunk IDLE ceiling for one streamed LLM round — the
    # deadline resets on every chunk, so a healthy long generation (which keeps streaming
    # reasoning/content) is never cut, but a genuine STALL (no bytes for this many seconds)
    # fails FAST and OBSERVABLY instead of riding the provider's silent 120s×3 read-timeout
    # ladder (~6 min of a frozen turn). Sized BELOW the httpx per-read 120s so this fires
    # first (and logs ``llm.stream_stalled``), and ABOVE worst-case time-to-first-token on a
    # large prompt so a big post-debate finalization call is not false-killed. 0 disables it.
    engine_llm_stream_idle_timeout_seconds: float = 100.0
    # force_finalize 绝对墙钟（秒）：硬顶/收敛收尾 LLM 流的独立上限。与 idle 闸正交——idle
    # 按 chunk 重置，长流可无限拖；本墙钟不重置，超时走既有 salvage（保留 prior 交付）。
    # 默认 120：保留防挂死墙，给大上下文健康长收尾留余地（巡检 60s 误砍偏多）。≤0 关闭。
    # 不改 mark_llm_inflight 暂停语义。
    engine_force_finalize_wall_seconds: float = 120.0

    observability_span_export_enabled: bool = True
