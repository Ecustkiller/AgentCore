# LV 诉茉莉奶白 · 干净环境宣传素材（导演台驱动）

| 项 | 值 |
|---|---|
| 磁带 | `demos/tapes/lv-molihua-trademark.json` |
| 生成时间 | 2026-07-18T04:47:17.181Z |
| 方式 | 生产构建 webapp（`dist-web` / vite preview）+ 导演控制台 REST + Playwright @ 1920×1080 |
| 账号 | `promo_lv`（display_name「演示」· 干净侧栏） |
| API | http://localhost:8015 |
| DEV 标 | **已去除**（生产构建，未改产品源码） |
| 避开 | 两段结辩 |

> 本目录为**干净版**重拍，覆盖旧 DEV 穿帮素材。新增项见下表 `new` 列。

## 环境卫生

- Webapp：`production dist-web via vite preview (import.meta.env.DEV=false)`
- DEV 徽章：无
- 账号片段：`AgentCore 搜索或运行命令… Ctrl+K 新对话 文件 消息 工具箱 暂无对话 开始第一次对话 → 演 演示`
- 开拍前侧栏会话数：0

## 静帧（`stills/`）

| id | 绝对路径 | 镜头 | 干净版 | 新增 | 导演驱动 |
|---|---|---|---|---|---|
| `01-user-prompt` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\01-user-prompt.png` | 用户输入开场 prompt / 第二幕 · 一句话发起 | 是 |  |  |
| `02-team-preview` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\02-team-preview.png` | 开工卡 / 授权开赛 / 第四幕组队+授权；冷开场可闪 | 是 |  |  |
| `03-debate-opening` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\03-debate-opening.png` | 辩论室开场 / 冷开场 / 第五幕引入 | 是 |  | live authorize + 辩论室 |
| `04-r2-diamond-square` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\04-r2-diamond-square.png` | 交锋1 · 公共元素 vs 获得显著性 / 交锋1 | 是 |  | repair: seek t_ms=450000 + R1 金句可见 |
| `04b-r2-quote-closeup` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\04b-r2-quote-closeup.png` | 交锋1 金句定点特写 / 交锋1 金句特写；须可见「任何经营者都不能垄断自然界公共资源的基本表达」 | 是 | 是 | repair: scroll-to-quote |
| `05-r3-logo-swap` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\05-r3-logo-swap.png` | 第2轮 · 跨类标准与真实使用 / 交锋2 | 是 |  | repair: chapter r2 + content gate |
| `05b-r4-logo-defense` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\05b-r4-logo-defense.png` | 第3轮 · 无茶饮消费者混淆调查 / 交锋3 | 是 |  | repair: chapter r3 + content gate |
| `06-r5-burden` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\06-r5-burden.png` | 第4轮 · 再钉实证门槛 / 交锋3 决胜 | 是 |  | disk-retained（第4轮交锋区） |
| `07-evidence-gap-admit` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\07-evidence-gap-admit.png` | 质询高光 · LV 承认无消费者调查（宽景） / 交锋3 质询高光 | 是 |  | seek t_ms=1130562 + hardReload + scroll |
| `07b-admit-closeup` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\07b-admit-closeup.png` | 质询承认句特写 / 交锋3 全片最强镜头；须可读「我承认没有消费者调查数据支撑…」 | 是 | 是 | seek t_ms=1130562 + scroll-to-admit |
| `08-final-verdict` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\08-final-verdict.png` | 主持人终审 · 微弱倾向茉莉奶白 / 冷开场 / 第六幕裁决 | 是 |  | repair: 终审区 +「微弱倾向茉莉奶白」可读 |
| `09-collab-graph` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\09-collab-graph.png` | 协作图 · 授权后团队结构 / 冷开场画面1 | 是 |  | disk-retained (not re-shot this run) |
| `09b-collab-graph-final` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\09b-collab-graph-final.png` | 协作图终态全貌（四轮打完） / 第七幕收尾 | 是 | 是 | disk-retained (not re-shot this run) |

### 新增镜头说明

- `04b-r2-quote-closeup` — R1 交锋金句定点；目标文案：任何经营者都不能垄断自然界公共资源的基本表达
- `07b-admit-closeup` — 质询承认句特写（全片最强镜头）；须可读「我承认没有消费者调查数据支撑…」；定点脚本 `promo_capture_lv_admit.mjs`
- `09b-collab-graph-final` — 协作图终态全貌（四轮+终审后），第七幕收尾
- `clip-streaming-debate-speed1` — SPEED=1 原速双列流式 5–15s（冷开场镜头2 备选）
- **勿设 `PROMO_WIPE=1`** 除非有意清空整树素材；默认续跑保留既有 stills/clips
- **默认不覆盖已有静帧**：导演台 / 主捕获需重拍时设 `PROMO_OVERWRITE=1` 或 `PROMO_OVERWRITE=id1,id2`；needle 未命中不写盘
- 坏帧定点修复：`node apps/desktop/scripts/promo_capture_lv_repair_stills.mjs`（内容门禁，未命中则不覆盖）

## 短视频 / 序列

- **full-session**: `C:\Project\AgentCore\apps\promo\assets\lv-molihua\clips\full-session.webm` — 整场（含导演 seek / SPEED=1 片段）
- **clip-streaming-debate-speed1**: `C:\Project\AgentCore\apps\promo\assets\lv-molihua\clips\clip-streaming-debate-speed1.webm` — SPEED=1 流式短片（自 full-session 尾部裁 ~12s）

## 导演控制台实战验收

| 功能 | 结果 | 说明 |
|---|---|---|
| pause | pass | before=playing after=paused (live post-authorize) |
| speed | pass | set 2→true; set 8→ speed=8 |
| resume | pass | state=playing |
| chapter_jump | pass | server t_ms=564170 chapter=第2轮·立论 |
| forward_seek | pass | t_ms 564251 → 1130562; admit_visible=true; hard_reload=true |
| rewind | pass | immediate_aligned=true; after_hard_reload_aligned=true; needed_manual_reload=false |
| cross_auth_seek | pass | after rewind→r1; server t_ms=165201 chapter=第1轮·立论 |

### 倒带与侧栏刷新

- 倒带后前端画面即时对齐，**无需**手动点侧栏刷新。

## 未产出 / 备注

- **04b-r2-quote-closeup**: 画面未检出完整金句「任何经营者都不能垄断自然界公共资源的基本表达」；磁带有原文。实际 UI:  返回正反辩论：茉莉奶白使用四叶花卉图形是否构成对LV商标权的侵权（基于苏州中院一审判决的重新审视）停止协作图辩论室四叶花图形的商标显著性掌舵正方正在续辩这场怎么读布局并排单栏第1轮第2轮主持人本场围绕茉莉奶白使用四叶花卉图形是否侵犯LV商
- **clip-streaming-debate-speed1**: director POST /seek → 404: {"error":{"code":"NOT_FOUND","message":"会话未绑定演示磁带"}}
- cleaned 1 prior conversations
- DEV badge absent (production build OK)
- clicked 授权开赛 before director tests
- R1 quote NOT in UI after seek+reload; actual:  返回正反辩论：茉莉奶白使用四叶花卉图形是否构成对LV商标权的侵权（基于苏州中院一审判决的重新审视）停止协作图辩论室四叶花图形的商标显著性掌舵正方正在续辩这场怎么读布局并排单栏第1轮第2轮主持人本场围绕茉莉奶白使用四叶花卉图形是否侵犯LV商标权展开重新审视。正方LV主张其四叶花商标经使用已获强显著性，且被告存在攀附故意
- 09-collab-graph: director POST /seek → 404: {"error":{"code":"NOT_FOUND","message":"会话未绑定演示磁带"}}
- acceptance diskOk=true transportOk=true files=01-user-prompt.png,02-team-preview.png,03-debate-opening.png,07b-admit-closeup.png,08-final-verdict.png

## 复现

```powershell
cd apps/desktop
$env:VITE_API_URL='http://localhost:8015'
pnpm build:webapp
# backend: DEMO_TAPE_REPLAY_ENABLED=true on :8015
$env:PROMO_API='http://localhost:8015'
$env:PROMO_USER='promo_lv'
$env:PROMO_PASS='promopass'
node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs
```
