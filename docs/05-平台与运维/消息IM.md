# 消息 IM（找人）

> **状态**：**P0（人 ↔ 人单聊）✅ 已落地（前后端全链路）**——后端 5 张 IM 表 + `MessagingService` + `/v1/messages` 全套 REST + `/v1/realtime` 每用户 SSE firehose（进程内 fan-out）+ 按用户发送限流；前端 `MessagesPage` 双栏（会话列表 + 线程 + 搜人发起 DM）+ firehose 消费 + 侧栏未读角标（§六）。⏳ 已确认未落地：官方号(C) 推送、P1（已读 UI / 在线态 / 联系人 / 隐私设置面）、P2（人群聊 / 富消息 / 人+AI 混合群）、多 worker 实时。
>
> **定位**：**对话页 = 找 AI，消息页 = 找人**——两入口共用前端聊天内核 + 实时通道，但 IM 另开一套后端表，与 AI 对话热路径解耦。
>
> 代码真相源：后端 `messaging/service.py`、`messaging/hub.py`、`messaging/events.py`、`api/routes/messages.py`、`api/routes/realtime.py`、`db/models.py`、`db/repositories.py`；前端 `renderer/services/messaging.ts`、`renderer/services/realtime.ts`、`renderer/stores/messaging.ts`、`renderer/pages/MessagesPage.tsx`、`renderer/components/messages/`。

---

## 一、定位与边界（✅ 已定）

| 决策 | 内容 |
|---|---|
| 双入口分工 | 对话页找 AI（保留），消息页找人（IM 收件箱）。纯 AI 团队群聊归对话页；消息页承载「人 ↔ 人」「官方号」「人 + AI 混合群（后置）」 |
| 复用边界 | 复用的是**前端组件 + 实时通道**，不是同一张表 |
| 关系模型 | **任意搜人**：按用户名 / ID 精确搜到即可发起，非好友前置；配套隐私 / 反滥用护栏（§五） |
| 实时通道 | **每用户一条 SSE firehose + POST 发送**（§四） |

**被否决**：① 扩 `messages` 加 `sender_user_id` 复用同表——污染 AI 热路径表、跨域耦合 AI 与社交两套演进；改为新开 IM 表。② 起步用 WebSocket——要新传输 + 新鉴权、脱离现有 401 刷新纪律；先用 SSE firehose 复用基建，真成瓶颈再上 WS。

## 二、数据模型（✅ 已落地，5 表）

遵循项目建模约定（UUID 主键、**无 ForeignKey**、`server_default`、按查询维度建索引；见 [`核心接口定义.md` §6.2](/docs/02-架构/核心接口定义.md)）。字段细节 → 见代码 `db/models.py`。

| 表 | 关键字段 | 说明 |
|---|---|---|
| `chats` | `type`(dm·group·official) / `title?` / `avatar_url?` / `created_by` / `last_message_at` / `last_message_preview` | IM 会话；`last_*` 供列表排序与预览 |
| `chat_members` | (`chat_id`+`user_id`) / `role`(owner·admin·member) / `state`(accepted·pending) / `last_read_message_id` / `muted` / `pinned` | 参与者 + 每人会话态；`state=pending` 即陌生人「消息请求」门；`last_read_*` 推未读数 |
| `chat_messages` | `chat_id` / `sender_user_id?`(null=系统) / `sender_type`(user·official·agent) / `content?` / `content_type`(text·image·file·system_card) / `attachments` / `payload?` / `reply_to_message_id?` / `client_msg_id`(幂等去重) | 人向消息；`client_msg_id` 解断网重发去重；`system_card`+`payload` 承载官方号 deep-link |
| `user_blocks` | (`user_id`+`blocked_user_id`) | 对称拉黑：断 DM + 双向搜索互隐 |
| `user_directory_settings` | `discoverable`(默认 true) / `who_can_dm`(默认 anyone) | 隐私自决；缺行 = 可被搜到（开放为默认） |

## 三、后端 API（✅ `/v1/messages`）

薄路由委托 `MessagingService`，权限在 service 层。**非会话成员一律 404**（IDOR 安全、不泄露存在性）。

| 端点 | 作用 | 关键策略 |
|---|---|---|
| `GET /messages/users/search` | 任意搜人 | 精确匹配；过滤自己 / 拉黑双方 / `discoverable=false` |
| `POST /messages/chats/dm` | 发起（或复用）单聊 | 幂等复用已有 DM；拒自聊 / 未知禁用对端 / 拉黑 / `who_can_dm=contacts`；对端入 `pending` |
| `GET /messages/chats` | 会话列表（近→远） | 批量解未读数 + DM 对端（无 N+1） |
| `GET /messages/chats/{id}/messages` | 消息分页（旧→新） | 非成员 404 |
| `POST /messages/chats/{id}/messages` | 发消息 | **先按用户发送限流**；成员 404 门 + DM 拉黑 403；`pending` 方回信即接受请求；落库后 fan-out 给全体成员（含自己，多端同步） |
| `POST /messages/chats/{id}/read` | 推进已读游标 | 驱动未读数 |
| `GET·PATCH /messages/directory` | 读 / 改隐私设置 | `discoverable` / `who_can_dm` |
| `GET·POST /messages/blocks`·`DELETE /messages/blocks/{id}` | 拉黑列表 / 拉黑 / 解除 | 拒自我拉黑；解除幂等 |

## 四、实时通道（✅ 进程内；⏳ 多 worker）

- **传输**：`GET /v1/realtime` 每用户一条长连 SSE firehose（server→client），发送走上面的 POST。鉴权复用 Cookie；此流自带 401→刷新→重连（[认证与会话 §六](/docs/05-平台与运维/认证与会话.md)），前端客户端见 `renderer/services/realtime.ts`（§六）。
- **fan-out**：A 发 → 落库 `chat_messages` → 经 `HubChatEventPublisher`（`messaging/hub.py` 进程内 pub/sub）推送给在线成员的 firehose。
- **离线补偿**：不另建表，上线时按 `last_read_message_id` 拉 `chat_messages` 增量。
- **多 worker（⏳）**：换 Redis / NATS pub-sub——`ChatEventPublisher` Protocol 已抽象（`events.py`），届时为 seam 局部替换，不动业务逻辑（同限流 / 审批门的多机化路径）。

## 五、隐私与反滥用（✅ 已落地护栏）

开放搜人滥用面大，起步即带默认护栏（实现细节，不改「任意搜人」决策）：

| 护栏 | 处理 |
|---|---|
| 防遍历 | 搜索按**精确**用户名 / ID，不做模糊枚举 |
| 隐私自决 | `discoverable`（可否被搜到）/ `who_can_dm`（anyone / contacts），默认开放 |
| 防骚扰 | 陌生人首条进「消息请求」（`chat_members.state=pending`），对方回信前受限 |
| 拉黑 | `user_blocks` 对称，断 DM + 互隐搜索 |
| 限流 | 发消息复用按用户限流（`conversation/rate_limit.py`） |
| IDOR | 会话操作先校验 `chat_members` 归属，非成员 404（[认证与会话 §八](/docs/05-平台与运维/认证与会话.md)） |

## 六、前端 MessagesPage（✅ 已落地）

桌面端「消息」两栏收件箱：复用对话页前端内核，但走**独立 store / service**，与 AI 对话状态解耦（对齐后端「另开 IM 表」边界）。

| 维度 | 现状 / 决策 |
|---|---|
| 布局 | 左 `ChatList`（会话列表 + 本地搜索 + `NewChatDialog` 搜人发起）+ 右 `ChatThread`（线程 + `ChatComposer`）；`/messages/:chatId` 深链，URL = 活动会话单一真相 |
| 数据层 | `services/messaging.ts`（REST 客户端 + 错误中文映射）+ `stores/messaging.ts`（Zustand）；类型手写镜像后端 schema（项目当前未跑 OpenAPI codegen） |
| 实时 | `services/realtime.ts` 消费 firehose，挂在 `AppShell`（**应用级、非页面级**）——故在对话页也能实时更新未读；事件喂 `applyIncoming`；每次（重）连触发离线补偿（重拉列表 + 重载当前线程，对齐 §四） |
| 发送 | 乐观上屏 + `client_msg_id`，服务端回执去重（对齐 §三幂等） |
| 未读角标 | 侧栏「消息」入口显总未读（`useUnreadTotal`，静音会话不计数）+ 列表行内每会话未读 |
| 气泡 | P0 纯文本（**非 Markdown**，区别于 AI 对话气泡）；`system_card` 居中胶囊占位 |
| 滚动 | 复用 `lib/useStickToBottom`（与对话页 `ChatView` 共享） |

## 七、未落地（⏳ 已确认设计）

| 项 | 现状 / 缺口 |
|---|---|
| 官方号(C) 推送 | 表 / schema 已留 `type=official`·`sender_type=official`·`system_card`+`payload`；**推送路径（任务完成 / 审批 → 写官方号会话 → deep-link 跳回对话页）业务逻辑未接** |
| P1 | 已读回执 UI、在线态 / 正在输入（走实时通道 + Redis TTL，不入库）、联系人收藏、隐私设置面板 |
| P2 | 人群聊、富消息（图 / 文件复用工作区上传）、**人 + AI 混合群**（`@` 唤起 agent → 接 CEO 编排，消息页独有差异化形态） |
| 多 worker 实时 | firehose / pub-sub 上 Redis / NATS（见 §四） |
