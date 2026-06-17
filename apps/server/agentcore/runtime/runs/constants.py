"""Run-model constants (统一 Run 模型 第一阶段).

Self-contained tunables for the ``runs`` package so it imports nothing outside
itself. The tree-wide concurrency budget lives here (not in a broad
``runtime.constants``) to keep ``runs`` a clean, dependency-light primitive.
"""

from __future__ import annotations

# Tree-wide cap on concurrently-running child runs across one turn's whole Run
# tree (the contextvar budget in ``concurrency.py`` enforces this across nested
# fan-outs). A wave's own width cap (WaveScheduler.max_parallel) is separate.
# 8 = headroom for parallel teams; overflow queues (so this bounds latency, not
# team size) and 8 concurrent calls are far under DeepSeek's per-account
# concurrency — the binding resource is the local machine, not the API.
MAX_PARALLEL_DELEGATIONS = 8

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

# Per-worker TOTAL budget (chars) for upstream dependency products injected into a
# downstream node's prompt, SHARED across all its pass_through deps (water-filled in
# runs/executor.py: a dep needing less takes only what it needs, the remainder goes
# to larger deps). A shared total — not a per-dep cap — so a wide fan-in can't
# multiply into a huge prompt (the old flat 4000-per-dep cap let N deps reach
# N×4000 unbounded). Sized to align with the CEO's own delegate-output budget
# (tools/builtin/delegate.py ``_DELEGATE_OUTPUT_LIMIT`` = 16000): a downstream writer
# synthesizing upstream research deserves as much context as the CEO synthesizing the
# batch. Replaces the old 4000 cap, which starved a research→writer chain — a long
# upstream was head-truncated, silently dropping its tail (金额 / 法条编号). When a dep
# must still be trimmed it is HEAD+TAIL truncated (executor `_truncate_head_tail`),
# not head-only, so trailing details survive.
DEP_CONTEXT_BUDGET = 16000

# Chars a summarize-policy dep (result_handling="summarize") is compressed to — a
# tight digest for the large-fan-in token-saving case, independent of (and far
# smaller than) the pass_through budget above.
DEP_SUMMARY_CHARS = 600

# 递指针不递全文 (Agent协作模式.md 远期 → 现状): when an upstream dependency already
# WROTE its product to the shared workspace (its ``files_touched`` is non-empty), a
# downstream worker gets a POINTER — a tight prose digest + the artifact paths to
# ``file_read`` — instead of the whole product re-shipped through the prompt. The
# artifact is on disk and reachable; re-injecting it whole wastes tokens and risks
# tail-trimming (the budgeted full-text path). These bound the pointer: how far the
# prose digest is cut, and how many paths to list before eliding. A pointer dep does
# NOT draw on DEP_CONTEXT_BUDGET (only PROSE pass_through deps, which have no file to
# point at, still share it).
DEP_POINTER_SUMMARY_CHARS = 600
DEP_POINTER_MAX_FILES = 20

# 工作区产物清单: every worker opens with a compact manifest of files in the shared
# workspace it can ``file_read`` — its ALREADY-FINISHED teammates' products this turn
# (from their ``files_touched``, role-attributed) PLUS the pre-existing files on disk
# (uploads / prior turns, via ``backend.index_files``), minus its own direct deps
# (those get the richer pointer block). So the workspace is a discoverable common
# context, not a passive store a worker must ``file_list`` to find — and it won't
# re-create an artifact a peer (or a past turn) already landed. Capped so a big team /
# large workspace can't bloat the prompt: a FILE-COUNT cap plus a CHAR budget (long
# paths can't blow up the prompt even under the count cap, whichever binds first), and
# the pre-existing files are fed newest-first (``index_files(order="recent")``) so the
# budget spends on what's most likely relevant, not whatever sorts alphabetically first.
WORKSPACE_MANIFEST_MAX_FILES = 40
WORKSPACE_MANIFEST_CHAR_BUDGET = 1800

# Canonical name of the worker-only「向上升级」tool (worker → CEO clarification
# channel). One source of truth shared by three sites that must agree without coupling
# ``runs`` to the ``tools`` package: the EscalateTool's schema name, the executor's
# allow-list guard (escalate is always offered even to a least-privilege worker), and
# serialize's transcript harvest (escalations_from_transcript). 见 docs/03-AI核心/Agent协作模式.md.
ESCALATE_TOOL_NAME = "escalate"

# Default per-node failure strategy (see RunPolicy.on_failure).
DEFAULT_ON_FAILURE = "degrade"

# The accepted on_failure vocabulary the WaveScheduler enacts.
VALID_ON_FAILURE = frozenset({"abort", "skip", "degrade", "retry"})
