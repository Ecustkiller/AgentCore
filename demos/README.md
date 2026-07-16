# 产品演示 · 服务端磁带回放（dev-only）

把一次真实运行的事件流做成磁带，之后在**真实桌面前端**准备一条云端会话并按原节奏重放，便于人工录屏。不进产品功能面——靠环境变量开关；关闭后 API 404、命令面板无入口。

## 阶段 0 结论（本仓库打样素材）

| 项 | 值 |
|---|---|
| conversation_id | `5d8bee05-d37f-4ddf-bfb1-4d6665a3d7db` |
| message_id | `714e38da-f5c8-4c75-b676-4a771e813462` |
| trace_id | `7174a9ad9fef45afaf81817143e132ea` |

- 完整可回放事实在**云 Postgres `turn_journal`**（1054 行，覆盖 CEO 接单 → 检索/案情简介 → `team_preview` → 5 轮辩论 → 结辩/裁决 → CEO 汇总）。
- 日志尾部有 `chat.local_turn_recorded`（本机 sidecar 跑完后 Outbox 回写），但 journal 已合并进云库，**不必再读本地 outbox**。

## 桌面端主路径：准备模式（录屏推荐）

> 前提：本机已能正常跑产品（Docker / `uv sync` / `pnpm install` 已就绪）。命令与 [`docs/02-架构/本地开发.md`](../docs/02-架构/本地开发.md) 一致。

录屏时请**亲自在输入框打字发送开场消息**（更真实）。内容任意——绑定会话上发消息即触发磁带回合；会话里显示的用户消息就是你实际发送的文本。建议照磁带 `meta.user_prompt` 原话打字（命令面板准备好后会复制到剪贴板，可粘贴）。

### A. 启动后端（开回放开关）

在 `apps/server/.env` 增加或确认：

```env
DEMO_TAPE_REPLAY_ENABLED=true
# 可选全局默认（一键启动 / 绑定文件里可覆盖）
DEMO_TAPE_SPEED=4
DEMO_TAPE_MAX_GAP_MS=2000
```

然后：

```bash
cd apps/server
uv run python -m agentcore
```

改 `.env` 后必须**重启**后端。`demos/tapes/*.json` 与 `demos/bindings.json` 是热读的。

### B. 启动桌面端

另开终端：

```bash
cd apps/desktop
pnpm dev
```

用已有账号登录（开发种子账号：`dev` / `devpassword`，见 `seed_dev_user.py`）。

### C. 命令面板 · 准备会话

1. **Ctrl/Cmd+K** 打开命令面板。
2. 搜「演示回放」或磁带标题（如「茉莉」）→ 选 **「演示回放 · …」**（hint：开发 · 准备）。
3. 桌面新建**云端**空会话并绑定磁带，**不**自动开回合；建议开场词已复制到剪贴板。
4. 在输入框粘贴/照磁带原话打字，发送任意消息 → 磁带接管推流。
5. 看到 **开工卡 / team_preview** 时，在真实 UI 点「授权开赛」。
6. 辩论按磁带节奏推流；协作图在授权后出现。结束后 CEO 汇总落库。切走再切回侧栏详情应正常。

开关关闭或后端未开回放时，该命令**不会出现**（`GET /v1/demo-tape` → 404）。

不要：默认「快速对话」、本地项目会话——一键入口已强制云端裸聊，勿再改绑本地。

### D. 可选：HTTP 冒烟（不启桌面）

后端开着且 `DEMO_TAPE_REPLAY_ENABLED=true`：

```bash
cd apps/server
# 主路径：prepare → 发消息 → SSE → resume
uv run python scripts/demo_tape_http_walk.py --tape lv-molihua-trademark

# 备选：auto-start（等同 POST /start）
uv run python scripts/demo_tape_http_walk.py --tape lv-molihua-trademark --autostart
```

准备模式脚本会：`POST /v1/demo-tape/prepare` → `POST …/messages`（触发文本）→ SSE 收到 `team_preview_required` → `POST …/resume` continue → 继续收流到结束，并校验会话中用户消息 = 发送文本、节奏上限。

---

## 备选：立即开播（auto-start）

命令面板搜「立即开播」，或选 **「演示回放 · … · 立即开播」**（hint：开发 · 一键）。行为与旧一键相同：`POST /v1/demo-tape/start` 建会话、绑定、并以磁带原始用户消息直接开回合；接口会等到首个耐久暂停（`team_preview`）落库后再返回。

桌面 UX 验收脚本 `apps/desktop/scripts/smoke-demo-tape.mjs` 走这条 auto-start 路径（六拍点），不必手打开场。

---

## 备选：手动建会话 + bind 脚本

若需调试绑定文件本身，仍可用旧路径：

1. 命令面板 → **「云端随手聊」**（或工作区 chip →「云端草稿」）建云端会话。
2. 绑定：

```bash
cd apps/server
uv run python scripts/demo_tape_bind.py --latest \
  --tape demos/tapes/lv-molihua-trademark.json \
  --speed 4 \
  --max-gap-ms 2000
```

3. 在该会话再发一条任意消息（内容会被忽略，磁带接管）。

`--latest` 默认只挑云端会话；强绑本地加 `--include-local`（桌面通常回放不到）。

---

## 导出磁带（已有打样时可跳过）

```bash
cd apps/server
uv run python scripts/demo_tape_export.py \
  --message-id 714e38da-f5c8-4c75-b676-4a771e813462 \
  --out ../../demos/tapes/lv-molihua-trademark.json
```

磁带放在仓库根 `demos/tapes/*.json`；一键目录按文件名 stem 列出（如 `lv-molihua-trademark`）。

## 倍速 / 间隔

| 参数 | 含义 |
|---|---|
| `speed` | `>1` 加快；原始间隔 ÷ speed |
| `max_gap_ms` | 单次等待上限（压住工具/思考长空窗） |

一键启动可用请求体覆盖；否则用 `.env` 全局默认。绑定文件优先于 `.env`（脚本路径）。

## 倍速实操备忘

- 原速 = `SPEED=1` + `MAX_GAP_MS` 抬到碰不着（如 `600000`）。本盘磁带回放总时长约 19.7 分钟，**真实最大间隔约 45 秒**（辩手 LLM 深度思考）——原速下的长静默是真实节奏，不是卡死。判断卡死的标准：发消息后 **3 秒内**连首批搜索活动都不出现。
- 录屏想压掉极端长等待：`MAX_GAP_MS=10000~15000`，其余节奏仍为真实。

## 设计决策（为什么长这样）

- **服务端磁带回放，而非前端注入**：重开会话/切页靠 REST 消息窗 + journal 水合，纯前端灌事件在用户切页时必穿帮；服务端回放落真实 DB 记录，一切页面行为天然成立。被否方案②：ScriptedProvider 重跑真实引擎——无 LLM 延迟导致节奏失真、prompt 漂移会对不上、工具副作用重复执行。
- **磁带源 = `turn_journal`**（只存 DURABLE 事件；流式 delta 由导出时重切块合成打字观感）。CEO 的**思考(reasoning)/正文(content)按 process timeline 逐段定位**——检索/分析/组队思考锚到各自的工具与案情简介之前、汇总思考锚到辩论之后；案情简介按真实段边界完整落在开工卡前（不再被 `_split_captain_text` 启发式腰斩）。**保真度以原始会话为真值 oracle**：改导出/回放层后，跑 `apps/server/scripts/demo_tape_fidelity_check.py` 比对「回放 vs 原始」（正文与思考均须逐字节一致、辩论投影结构等价），不要目测。reasoning 真值 = captain `process_reasoning` 段拼接（与 `messages.reasoning_content` 仅差暂停边界的 `\n\n` 连接符）。
- **暂停即真实检查点**：磁带遇 `team_preview` 真暂停、等用户在 UI 点继续——演示中人类拍板环节由录屏者掌控。
- **节奏坑（已修勿回退）**：磁带 `t_ms` 必须单调；player 的 pacing 时钟不可回拨（曾因导出切块时间回跳 + 时钟回拨双计时，在原速下表现为「正在思考」长卡死，4 倍速+2s 限幅时被掩盖）。
- **时间窗铺满 + 直播感重建（已修勿回退）**：journal 只存 DURABLE 事实，照搬时间戳会导致「文字一坨闪现 + 长死窗」。导出层负责重建直播观感，不变量（`demo-tape-out/_check_pacing.py` 一键验收）：
  - **船长 reasoning/content 铺满真实锚点窗**：按 process timeline 定位归属窗口（如「上一锚点 → 编排工具」「最后编排 `tool_use_end` → `run_completed`」收尾窗），窗内按拍数比例均匀铺开（切片间隔 15ms~1.2s），顺序恒为 reasoning 先、content 后；末拍贴住窗尾。曾坏过两次：所有切片挤在同一毫秒；收尾总结插错窗（content 在 debate `tool_use_end` 之前 + 尾部 9.7s 空洞）。
  - **worker 流式重建**：`run_output_delta`/`run_reasoning_delta` 是 EPHEMERAL（journal 不存），由 `message_final` + `run_process_*` 反推，按**间隙容量比例装箱**铺满该 run 的 `run_started→run_completed` 窗口（勿用「逐工具锚定+硬冲刷」——并发 run 交错时会把整段文本压进零宽窗，留下大段辩手静默）。
  - **组队前的「委派中」心跳**：CEO 编排工具（`delegate`/`debate`）流式组装参数期间前端靠 `tool_progress`（EPHEMERAL）显示「Composing …」。导出时在（简介结束 → 开工卡）窗内合成递增 `chars` 的心跳序列，桌面 `TOOL_META` 已有 `debate` 条目。否则开工卡前是纯白屏。
  - **player 跳过不可发射事件再计步**：`turn_paused` 等非 SSE 事实必须在 pacing 计算**之前**跳过，否则它们推进节奏时钟——曾表现为点「授权开赛」后 11 秒静默（resume 首拍应即时发出）。
- **CEO 自持工具内联（已修勿回退）**：CEO 检索阶段的 `web_search`/`read_url` 在运行时带 captain 自己的 `run_id`；前端 `appendToolStep` 与后端 `_accumulate_process` 都把「带 run_id 的工具」当作 worker 工具从内联时间线剔除（本该落协作图节点），但检索阶段协作图尚未出现 → 前 ~15 秒只显示「正在思考」、检索活动全隐藏（正是上一条「3 秒内无首批搜索活动」判据的触发场景）。修法：player 回放时对 `run_id == captain run` 的 `tool_use_*` 事件剥离 `run_id`，使 CEO 自持工具按渲染契约（conformance `single_agent` 向量：CEO 工具无 run_id）走 turn-level 内联。磁带数据保持忠实录制（含 run_id），仅在渲染适配层归一。见 `player.py:_captain_run_id` + 单测 `test_player_inlines_captain_tools_by_stripping_run_id`。**真实产品同源已在 runtime 一并修掉**（旧磁带仍靠 player 层剥离兜底）：`execute_tools`（`runtime/engine/tool_exec.py`）对 `role=="captain"` 走 display/trace 拆分——`tool_use_*` 的 SSE 事件不发 `run_id`（内联渲染），`ToolCallFact`/熔断审计仍保留 captain `run_id`（§8.3 fold/溯源不变）；两处调用点 `tool_round.py`、`directive_apply.py`（coordination 收尾）均已传 `role`。

## 复用到新场景

任何满意的真实运行（云端回合；sidecar 跑的回写云库后同样可用）→ `demo_tape_export.py --message-id <id>` 出新磁带放 `demos/tapes/` → 命令面板自动多出该磁带的准备/立即两条入口。查 message_id：`uv run python scripts/log_timeline.py <conversation_id>`。

## 边界

- **不改** SSE / 协议契约、**不动**产品默认 UI（仅命令面板在开关开启时多准备/立即两条入口）。
- 回放 `cost_runs=[]`，尽量不写成本账本。
- 仅支持磁带中的 `team_preview` 暂停；其它检查点种类未接线。
- 一盘磁带 = 一个回合；多回合演示剧本需扩展（磁带分段、逐条消息续播）。
- 桌面误绑本地会话 → 发消息走 sidecar，服务端绑定无效（表象：普通 AI 回复，无磁带节奏）——一键入口已避免此坑。
