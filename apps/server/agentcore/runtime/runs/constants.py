"""Run-model constants (统一 Run 模型 第一阶段).

Self-contained tunables for the ``runs`` package so it imports nothing outside
itself. The tree-wide concurrency budget lives here (not in a broad
``runtime.constants``) to keep ``runs`` a clean, dependency-light primitive.
"""

from __future__ import annotations

# Tree-wide cap on concurrently-running child runs across one turn's whole Run
# tree (the contextvar budget in ``concurrency.py`` enforces this across nested
# fan-outs). A wave's own width cap (WaveScheduler.max_parallel) is separate.
MAX_PARALLEL_DELEGATIONS = 6

# Most worker tasks one delegate call may spawn. Excess tasks are dropped.
MAX_DELEGATION_TASKS = 10

# Hard ceiling on delegation nesting across one turn's Run tree. The CEO's direct
# workers are depth 1; a worker may itself delegate (开一层子团队) ONLY while its own
# depth < this cap, so the tree can never nest past CEO → worker → sub-worker.
# depth-2 sub-workers never receive a delegate tool. Bounds recursion (cost /
# latency / fan-out) on top of the tree-wide width budget (MAX_PARALLEL_DELEGATIONS).
MAX_DELEGATION_DEPTH = 2

# Hard ceiling on per-node retries regardless of what a task declares.
MAX_RUN_RETRIES = 3

# Contract-gate retries are SEPARATE from the scheduler's failure retries
# (MAX_RUN_RETRIES): the latter re-runs on infra failure (crash/timeout), the
# former re-runs on *content* not meeting its contract, re-prompting with the
# specific shortfalls. Default 1 (one correction chance), hard-capped so a
# pathological contract can't loop a worker forever.
DEFAULT_CONTRACT_RETRIES = 1
MAX_CONTRACT_RETRIES = 3

# 定向唤回（乙 热修）改次闸：一个 worker run 累计可被 ``revise`` 续写的次数上限，防无限
# 打磨。参照 contract 的「一次自动返工」给人工热修略宽到 3；超限后 revise 拒绝并提示
# 回落甲（带旧产物重新 delegate 换人重做）。
# → 见设计: docs/03-AI核心/多轮编排与队员热修.md §六 T-3
DEFAULT_RECALL_LIMIT = 3

# 留人 roster（乙 热修）内存治理 (P2)：进程内留住 worker session 供【跨回合】定向唤回，
# 对齐 approvals / channel / locks 的单机 posture（多进程扩展时换 Redis）。三道闸防内存
# 无界增长 + 一道闸防跨会话泄漏：
# → 见设计: docs/03-AI核心/多轮编排与队员热修.md §六 T-4
# 单个 conversation 的 roster 最多留多少个可恢复 session（超出按 LRU 淘汰最久未访问的）。
DEFAULT_ROSTER_MAX_SESSIONS = 32
# 单个 conversation 的 roster transcript 总字节上限，防一个长会话的留存吃爆内存。
DEFAULT_ROSTER_MAX_BYTES = 8 * 1024 * 1024  # 8 MiB
# session / conversation roster 的空闲存活时长：超过即视为过期，定向唤回 落空回落甲。
DEFAULT_ROSTER_TTL_SECONDS = 30 * 60.0  # 30 min
# 进程内最多同时留多少个 conversation 的 roster（超出按 LRU 淘汰最久未访问的会话）。
DEFAULT_ROSTER_MAX_CONVERSATIONS = 256

# Default per-node failure strategy (see RunPolicy.on_failure).
DEFAULT_ON_FAILURE = "degrade"

# The accepted on_failure vocabulary the WaveScheduler enacts.
VALID_ON_FAILURE = frozenset({"abort", "skip", "degrade", "retry"})
