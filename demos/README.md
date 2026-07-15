# 产品演示 · 服务端磁带回放（dev-only）

把一次真实运行的事件流做成磁带，之后在**真实桌面前端**准备一条云端会话并按原节奏重放，便于人工录屏。不进产品功能面——靠环境变量开关；关闭后 API 404、命令面板无入口。

## 阶段 0 结论（本仓库打样素材）

| 项 | 值 |
|---|---|
| conversation_id | `33d84eca-b3ef-43e0-aa86-84241a97eb32` |
| message_id | `3654bda5-e84b-4d41-a75c-092f454bf012` |
| trace_id | `83eb3ee9a0a54acaa34c8c38ed2ea520` |

- 完整可回放事实在**云 Postgres `turn_journal`**（665 行，覆盖 CEO 接单 → `team_preview` → 4 轮辩论 → 结辩/裁决 → CEO 汇总）。
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
  --message-id 3654bda5-e84b-4d41-a75c-092f454bf012 \
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
- **磁带源 = `turn_journal`**（只存 DURABLE 事件；流式 delta 由导出时重切块合成打字观感）。**保真度以原始会话为真值 oracle**：改导出/回放层后，用 `demo-tape-out/` 下保真脚本比对「回放 vs 原始」（正文须逐字节一致、辩论投影结构等价），不要目测。
- **暂停即真实检查点**：磁带遇 `team_preview` 真暂停、等用户在 UI 点继续——演示中人类拍板环节由录屏者掌控。
- **节奏坑（已修勿回退）**：磁带 `t_ms` 必须单调；player 的 pacing 时钟不可回拨（曾因导出切块时间回跳 + 时钟回拨双计时，在原速下表现为「正在思考」长卡死，4 倍速+2s 限幅时被掩盖）。

## 复用到新场景

任何满意的真实运行（云端回合；sidecar 跑的回写云库后同样可用）→ `demo_tape_export.py --message-id <id>` 出新磁带放 `demos/tapes/` → 命令面板自动多出该磁带的准备/立即两条入口。查 message_id：`uv run python scripts/log_timeline.py <conversation_id>`。

## 边界

- **不改** SSE / 协议契约、**不动**产品默认 UI（仅命令面板在开关开启时多准备/立即两条入口）。
- 回放 `cost_runs=[]`，尽量不写成本账本。
- 仅支持磁带中的 `team_preview` 暂停；其它检查点种类未接线。
- 一盘磁带 = 一个回合；多回合演示剧本需扩展（磁带分段、逐条消息续播）。
- 桌面误绑本地会话 → 发消息走 sidecar，服务端绑定无效（表象：普通 AI 回复，无磁带节奏）——一键入口已避免此坑。
