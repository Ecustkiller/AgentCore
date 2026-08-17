# 质量案册（quality-cases）

> **状态**：案卡 schema + 状态机 lint + 开案草稿 ✅；真案目录起步为空。  
> **用途**：把人已经做出的质量判断归档，供后续题库 / 改动追溯。  
> **正交**：与 [`evals/dogfood/`](../dogfood/README.md)（恰好 20 槽、observe_only）分立。

## 定案摘要（Q3 / Q7 / Q8）

| 代号 | 定案 |
|------|------|
| **Q3** | 载体 = 仓内结构化文件，本目录一案一文件。不塞进 dogfood manifest。 |
| **Q7** | lint 挂在仓根 `lint_cases.py`；`apps/server/tests/test_quality_cases_lint.py` 是 **wrapper**，只跑 hard 档，进 backend pytest。 |
| **Q8** | 允许机器草稿：`draft_from_patrol.py` 读 `log_patrol --json` 快照，生成 `status=open` / `verdict=undecided`。人确认才进 `triaged`。`patrol.py` 本身不动。 |

ID = `qc-<YYYYMMDD>-<slug>`。多 worktree 并行开案，不用单调序号。

## 门禁边界

| 对象 | 进门禁？ |
|------|----------|
| 结构非法（状态机、必填、`status × verdict` 矩阵）、疑似正文 | **是，挡 PR** —— 格式合规与硬约束，不是质量结论 |
| warn 档（相似案、自由文含 `%` / `占比` / `显著`） | 否，仓根自愿跑 |
| 案卡的 `verdict` / 内容对错 | 否，`observe_only` |

仓根 `evals/` 不在 backend pytest 收集树内（`testpaths = ["tests"]`）；也不能扩 `testpaths`——`evals/code-capability/` 里有 vendor 的 `test_*.py`。wrapper 是唯一诚实挂载。

```bash
# 仓库根：hard + warn（warn 不改退出码）
python evals/quality-cases/lint_cases.py
python evals/quality-cases/lint_cases.py --hard-only
python evals/quality-cases/lint_cases.py evals/quality-cases/fixtures/legal

# backend pytest wrapper（只跑 hard，对着真案目录 cases/）
# 在 apps/server 下：
uv run pytest tests/test_quality_cases_lint.py tests/test_quality_cases_draft.py -q
```

## 字段

见 [`schema.json`](schema.json)。要点：

- `suspected_knobs` / `knobs_changed` 分开，都是 `kind:name` 数组。
- `occurrence_log` 记各窗 `{window, n}`；`n` 的口径仍待决，草稿脚本写入快照的 `families.*.events`（事件数）。
- `signal_tier` / `repro_tier` 拆开。`signal_tier=production` 时 `traces` 或 `conversations` 必须非空。
- `fix_class=intercept` 时，进 `fixed` 必须带齐拦截三项：`false_positive_surface`（误伤面）、`why_ladder_insufficient`（为何阶梯 1–2 不够）、`soft_net_negative`（软是否净负）。
- `history` 记 `(status, verdict)` 联合转移：`status` / `verdict` 均为 `[from, to]`。空 history 只允许 `open` + `undecided`。
- **禁止**把 patrol 快照的 `first_user_preview` / `last_user_preview` 写入任何字段。

## 状态机（lint hard）

合法转移（其余全非法）：

| 从 | 到 | 条件 |
|---|---|---|
| `open` | `triaged` | 分诊完成（verdict 可为实值，也可停在 `undecided`） |
| `open` | `closed(duplicate)` | 须填 `duplicate_of`；verdict 不得停在 `undecided` |
| `triaged` | `reproduced` | `verdict=defect` 且至少一类可复跑指针非空 |
| `triaged` | `closed(not_a_defect \| wont_fix)` | verdict ∈ {`noise`, `honest_refusal`, `wont_fix`} |
| `reproduced` | `fixed` | `fix_commits` 非空（题是否真红转绿靠人） |
| `reproduced` | `closed(wont_fix \| not_a_defect)` | 须 note |
| `fixed` | `closed(resolved)` | 正常终态 |
| `fixed` | `closed(abandoned)` | 须 note |
| `fixed` | `regressed` | 复发 |
| `closed(resolved)` | `regressed` | 复发。history 不记 `close_reason`，lint 用「from verdict=defect」近似 |
| `closed` | `triaged` | 仅当 verdict 从非缺陷翻成 `defect`；须 note |
| `regressed` | `reproduced` | 唯一去向 |

`status × verdict` 合法矩阵：`open` 只能 `undecided`；`triaged` 可停 `undecided` / `defect`，非缺陷 verdict 须同批进 `closed`（不得停在 `triaged`）；`reproduced` / `fixed` / `regressed` 必须 `defect`；`closed` 禁止 `undecided`。

## 纪律分档

| # | 纪律 | 档 | lint |
|---|---|---|---|
| 1 | 复现门：不许 `triaged` 直跳 `fixed` | **hard** | 非法转移；`reproduced` 及之后指针至少一类非空 |
| 2 | 复发不新开案 | hard + warn | hard：`regressed` 必须有过 `fixed` 或 `closed→regressed`；warn：同 family + trace 重叠 + slug 相似 |
| 3 | 判为 noise 也要留档 | hard | 非缺陷 verdict 必须有 `verdict_note` 且 evidence 非空 |
| 4 | 禁比率 / 趋势 | hard + warn | hard：禁 `rate` / `pct` / `percentage` 等字段名；warn：自由文 `%` / `占比` / `显著` |
| 5 | 正文不入仓 | **hard** | 自由文字段长度上限 + 疑似正文形态（角色标记、预览字段名、消息 JSON 残片） |
| 6 | 拦截提案格式 | hard | `fix_class=intercept` 且提案缺项 → 不许进 `fixed` |

纪律 5 的可执行上限（语义级脱敏仍靠人）：`symptom` ≤ 200；`verdict_note` / `history[].note` ≤ 400；`family_candidate` ≤ 120。

## 开案草稿（Q8）

```bash
# 先出快照（apps/server）
uv run python scripts/log_patrol.py --export-dir ../../logs/prod-export --since 2d --json > /tmp/patrol.json

# 仓库根：默认 signal_tier=dogfood；生产窗显式传入
python evals/quality-cases/draft_from_patrol.py --snapshot /tmp/patrol.json
python evals/quality-cases/draft_from_patrol.py --snapshot /tmp/patrol.json --signal-tier production
python evals/quality-cases/draft_from_patrol.py --snapshot /tmp/patrol.json --dry-run
```

- 每个有 `events > 0` 的家族一张草稿；`unknown_or_new` 写 `family=null`、`family_candidate=unknown_or_new`。
- 只抄 `families.*.traces.ids` / `conversations.ids`。没有 id 且 `--signal-tier production` → 跳过该族，**不编造**。
- **禁止**抄会话行上的 60 字用户预览。
- 人确认后才把 `status` 改成 `triaged`。

## 目录

| 路径 | 说明 |
|------|------|
| [`schema.json`](schema.json) | 字段契约（状态机由 lint 执行） |
| [`lint_cases.py`](lint_cases.py) | 零 LLM，hard / warn |
| [`draft_from_patrol.py`](draft_from_patrol.py) | Q8 开案草稿 |
| [`cases/`](cases/) | 真案；起步为空。合法/非法样例在 `fixtures/`，不进案册 |
| [`fixtures/`](fixtures/) | lint / 草稿测试夹具（合成 id，不是生产证据） |

## 非目标

案册数量 / 修复率进 `release:gate`、LLM 自动写 `symptom` / 打 `verdict`、patrol 自动转正、把案塞进 dogfood manifest。
