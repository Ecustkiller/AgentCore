# LV 诉茉莉奶白 · 干净环境宣传素材

| 项 | 值 |
|---|---|
| 磁带 | `demos/tapes/lv-molihua-trademark.json` |
| 生成时间 | 2026-07-18T04:18:21.204Z |
| 方式 | server demo-tape replay + Playwright production webapp (dist-web / vite preview) @ 1920×1080 — clean, no DEV badge |
| 账号 | `promo_lv`（display_name「演示」） |
| DEV 标 | **已去除**（生产构建 dist-web，未改产品源码） |
| 回放 | speed=12, max_gap_ms=800 |
| 视口 | 1920×1080 |
| 验收 ok | true |

> 本目录为**干净版**重拍。导演控制台实战验收见下文 / `director-acceptance.json`。

## 静帧（绝对路径）

| id | 绝对路径 | 镜头 | 干净版 | 新增 |
|---|---|---|---|---|
| `01-user-prompt` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\01-user-prompt.png` | 用户输入开场 prompt / 冷开场前 / 第二幕：展示「只打了这么一句话」 |  |  |
| `02-team-preview` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\02-team-preview.png` | captain 组建辩论团队 / 开工卡 / 冷开场 / 第四幕：team_preview 双方立场 |  |  |
| `09-collab-graph` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\09-collab-graph.png` | 协作图 / 团队结构可视化 / 冷开场快闪；收尾拉远 |  |  |
| `03-debate-opening` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\03-debate-opening.png` | 辩论开场：双方与辩题（显著性） / 第五幕精剪 / 冷开场 | 是 |  |
| `04-r2-diamond-square` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\04-r2-diamond-square.png` | 交锋1 · 公共元素 vs 获得显著性 / 第五幕精剪 / 冷开场 | 是 |  |
| `04b-r2-quote-closeup` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\04b-r2-quote-closeup.png` | 交锋1 金句定点特写 / 交锋1 金句；须可见「任何经营者都不能垄断自然界公共资源的基本表达」 | 是 | 是 |
| `05-r3-logo-swap` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\05-r3-logo-swap.png` | 交锋2 · 跨类标准与真实使用 / 第五幕精剪 / 冷开场 | 是 |  |
| `05b-r4-logo-defense` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\05b-r4-logo-defense.png` | 交锋3 · 无茶饮消费者混淆调查 / 第五幕精剪 / 冷开场 | 是 |  |
| `07-evidence-gap-admit` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\07-evidence-gap-admit.png` | 质询高光 · LV 承认无消费者调查（宽景） / 交锋3 | 是 |  |
| `07b-admit-closeup` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\07b-admit-closeup.png` | **质询承认句特写** / 交锋3 全片最强镜头；原话「我承认没有消费者调查数据支撑…」 | 是 | 是 |
| `06-r5-burden` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\06-r5-burden.png` | 交锋3 决胜 · R4 再钉实证门槛 / 第五幕精剪 / 冷开场 | 是 |  |
| `08-final-verdict` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\08-final-verdict.png` | 最终裁决（微弱倾向茉莉奶白 · 55%） / 第五幕精剪 / 冷开场 | 是 |  |
| `09b-collab-graph-final` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\09b-collab-graph-final.png` | 协作图终态全貌（四轮打完） / 第七幕收尾 | 是 | 是 |

### 新增镜头

- `04b-r2-quote-closeup` — 交锋1 金句；「任何经营者都不能垄断自然界公共资源的基本表达」
- `07b-admit-closeup` — 交锋3 承认句特写；「我承认没有消费者调查数据支撑“茶饮消费者看到四叶花联想到LV”的主张」
- `09b-collab-graph-final` — 协作图终态全貌（四轮后），第七幕收尾
- `clip-streaming-debate-speed1` — SPEED=1 原速流式（冷开场镜头2）

### 封面级侧栏

`03` / `09` / `09b`：主捕获开拍前 `DELETE /v1/conversations` 清空 `promo_lv` 会话，侧栏仅当前一条。`07b` 等交锋特写可能残留多条同题会话（非封面级，可接受）。

## 短视频 / 序列

- **full-session**: `C:\Project\AgentCore\apps\promo\assets\lv-molihua\clips\full-session.webm` — 整场回放（Playwright recordVideo）
- 序列 **clip-round-advance**: `C:\Project\AgentCore\apps\promo\assets\lv-molihua\sequences\clip-round-advance` (11 帧)

## 导演控制台实战验收

| 功能 | 结果 | 说明 |
|---|---|---|
| pause | pass | 在离开 team_preview 后的 playing 态：playing→paused。若在 awaiting_interaction（授权卡）上点暂停，状态名不变（仍为 awaiting_interaction），易误判为无效——应在播放中段测暂停。 |
| speed | pass | 动态 2× / 8× 瞬时生效（status.speed 正确） |
| resume | pass | soft-pause 后 resume → playing |
| chapter_jump | pass | 章节跳 r1_argument：服务端 t_ms/chapter_label 正确；跨授权会 auto-resolve。前端需保持直播 SSE 或硬刷新会话才能看到辩论室画面（纯 seek 后 SPA 可能仍停在案情简介）。 |
| forward_seek | pass | 向前 seek t_ms 65996→319000 服务端成功；前端画面需直播会话或硬刷新才对齐证据缺口文案 |
| rewind | pass | 重启式倒带回 team_preview：本轮 immediate_aligned=true，无需手动点侧栏。已知疑点未复现（可能因硬刷新路径 / 干净账号）。 |
| cross_auth_seek | pass | 从授权卡 seek 越过 team_preview：服务端代确认成功，授权卡消失。前端辩论室内容依赖直播 fold，硬刷新后可见案情+进度但不一定自动打开辩论室双列。 |
| frontend_sync_after_seek | partial | 导演 seek/倒带改的是服务端注入与 DB；产品前端未订阅导演通道。实拍静帧应走「直播回放 + 导演变速/暂停」，章节跳更适合掐点预览而非直接截图。硬刷新会话可部分对齐，辩论室需再点「打开辩论室」。 |

- 倒带后前端即时对齐（本轮未复现「必须点侧栏」）。

## 未产出 / 备注

- （无缺失）
- cleaned 1 prior conversations
- DEV badge absent (production build)
- 短视频：已产出 full-session.webm；未做自动裁切。若需 5–15s 片段，用 ffmpeg 按 assets 的 wall_ms 裁切，或使用 sequences/ 密集帧。

## 避开

- 两段结辩（closing）画面故意不采。

## 复现

```powershell
cd apps/desktop
$env:VITE_API_URL='http://localhost:8015'
pnpm build:webapp   # 去 DEV 标
# backend DEMO_TAPE_REPLAY_ENABLED on :8015（含导演台路由）
$env:PROMO_API='http://localhost:8015'
$env:PROMO_USER='promo_lv'; $env:PROMO_PASS='promopass'
node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs  # 导演验收
node apps/desktop/scripts/promo_capture_lv_molihua.mjs           # 干净静帧（直播回放）
```
