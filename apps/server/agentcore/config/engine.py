"""ReAct engine loop: timeouts, governance, tool-clear, finish-guard."""

from pydantic import BaseModel


class EngineSettings(BaseModel):
    tool_default_timeout_seconds: float = 60.0
    tool_execution_timeout_seconds: float = 90.0

    engine_empty_response_threshold: int = 2

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
    # Absolute investigation-round ceiling (safety net). Progress-aware spinning detection
    # normally triggers earlier; this is the hard backstop. Must be ≤ worker agent
    # max_rounds (56) or the cap never fires before the loop exits.
    engine_convergence_finalize_rounds: int = 48
    # Consecutive investigation-only rounds re-reading the same targets before finalize.
    engine_convergence_spin_rounds: int = 3
    # 交文件队员久读无写（与 token/timeout wind_down 解耦；不做 FINALIZE/FAILED）：
    # 修码 files_expected：连续纯调查轮 nudge → soft「先改或交接」；达 narrow →
    # 复用 wind_down 白名单收窄工具（卸检索）。报告岗（结构化谓词）仅 nudge 催写报告，
    # narrow_rounds=0，永不卸检索。仅 files_expected 且非 prose 开启。≤0 关闭对应阶。
    # 默认 8/10：交文件多留摸仓轮次再催；修码 narrow 仍晚于 nudge，梯子不反序。
    # 与 recon 默认 8 对齐首催时机；仍远低于绝对收敛顶（48）。
    engine_delivery_idle_nudge_rounds: int = 8
    engine_delivery_idle_narrow_rounds: int = 10
    # 非交文件（调查/诊断）队员：久读无结论只 soft nudge，不收窄工具、不 FINALIZE。
    # 与 delivery_idle 共用纯调查轮计数器；文案催 handoff/escalate/收敛，不催写盘。
    # ≤0 关闭。默认 8：在绝对顶（48）之前给一次刹车。
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

    engine_tool_clear_keep_recent: int = 4
    engine_tool_clear_min_chars: int = 2000
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
