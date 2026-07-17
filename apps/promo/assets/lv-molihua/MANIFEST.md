# LV 诉茉莉奶白 · 干净环境宣传素材

| 项 | 值 |
|---|---|
| 磁带 | `demos/tapes/lv-molihua-trademark.json` |
| 分镜参考 | `demos/video-plan-lv-molihua.md` |
| 生成方式 | **生产构建** webapp（`pnpm build:webapp` → `dist-web` + vite preview）+ 服务端磁带回放 + Playwright @ **1920×1080** |
| 账号 | `promo_lv` / display_name **「演示」**（侧栏无历史杂音） |
| DEV 标 | **已去除**（`import.meta.env.DEV=false`，**未改产品源码**） |
| 导演台 | `http://localhost:8015/v1/demo-tape/director`（验收见下） |
| 避开 | 两段结辩 |

> 本目录为**干净版**重拍，覆盖旧「AgentCore DEV / Dev 账号 / 侧栏脏会话」穿帮素材。

## 环境卫生结论

| 问题 | 办法 | 是否改产品源码 |
|---|---|---|
| 标题旁 DEV 徽章 | 用 `pnpm build:webapp` 生产构建再 `vite preview` 拍（徽章由 `import.meta.env.DEV` 门控） | **否** |
| Electron 标题 `AgentCore [DEV]` | 本套素材走 **webapp**，不涉及 Electron `is.dev` 标题 | 否（若将来拍 Electron 壳，需生产打包或改 `apps/desktop/src/main/index.ts`） |
| 左下角 Dev 账号 | 新建用户 `promo_lv`，`display_name=演示`（`seed` + `UserRepository.update`） | **否** |
| 侧栏历史杂音 | 干净账号 + 开拍前 `DELETE /v1/conversations` | **否** |

## 静帧（`stills/` · 全部干净版）

| id | 绝对路径 | 镜头 / 用途 | 新增 |
|---|---|---|---|
| `01-user-prompt` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\01-user-prompt.png` | 第二幕「一句话发起」 | |
| `02-team-preview` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\02-team-preview.png` | 第四幕组队+授权 | |
| `03-debate-opening` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\03-debate-opening.png` | 冷开场 / 第五幕引入（双方正在立论） | |
| `04-r2-diamond-square` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\04-r2-diamond-square.png` | 交锋1 · R2 | |
| `04b-r2-quote-closeup` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\04b-r2-quote-closeup.png` | **R2 金句特写**（可见「对方在拿『菱形』论证『正方形』」） | **是** |
| `05-r3-logo-swap` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\05-r3-logo-swap.png` | 交锋2 前半 · 换标 | |
| `05b-r4-logo-defense` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\05b-r4-logo-defense.png` | 交锋2 · 小程序/客服头像 | |
| `06-r5-burden` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\06-r5-burden.png` | 交锋3 · 举证责任 | |
| `07-evidence-gap-admit` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\07-evidence-gap-admit.png` | 质询高光 · 证据缺口 | |
| `08-final-verdict` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\08-final-verdict.png` | 第六幕裁决 · 「倾向茉莉奶白」+「置信 高」 | |
| `09-collab-graph` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\09-collab-graph.png` | 冷开场画面1 · 授权后协作图 | |
| `09b-collab-graph-final` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\stills\09b-collab-graph-final.png` | **第七幕收尾** · 五轮+结局协作图全貌 | **是** |

### 金句原文（磁带 / UI 一致）

> 对方在拿“菱形”论证“正方形”，以抽象类别否定具体保护。

（弯引号；出现在 R2 正方立论段落。）

### 关于「65%」

磁带 brief 含 65%；UI 终审卡显示档位 **「置信 高」**（非百分数）。成片可用字幕叠 65%。

## 短视频 / 序列

| id | 绝对路径 | 说明 | 新增 |
|---|---|---|---|
| `full-session` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\clips\full-session.webm` | 加速整场 Playwright 录制 | |
| `clip-streaming-debate-speed1` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\clips\clip-streaming-debate-speed1.webm` | **SPEED=1** 原速双列流式（冷开场镜头2 备选）；导演台切 1× 后录约 12s | **是** |
| 序列 `clip-streaming-debate-speed1` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\sequences\clip-streaming-debate-speed1\` | 12 帧 @1s · 同上 | **是** |
| 序列 `clip-round-advance` | `C:\Project\AgentCore\apps\promo\assets\lv-molihua\sequences\clip-round-advance\` | 轮次推进补帧 | |

## 导演控制台实战验收

详见 `director-acceptance.json`。摘要：

| 功能 | 实测 | 说明 |
|---|---|---|
| 暂停 | **pass** | `playing → paused` 有效。若在 `awaiting_interaction`（授权卡）上点暂停，对外 state 仍显示 `awaiting_interaction`，易误判——应在中段播放时测。 |
| 变速 | **pass** | 2× / 8× 瞬时生效 |
| 继续 | **pass** | soft-pause 后 resume → playing |
| 章节跳 | **pass**（服务端） | `chapter_id` 跳转与跨授权 auto-resolve 正确；**前端**无导演订阅，纯 seek 后 SPA 可能停在案情简介，需保持直播 SSE 或硬刷新+点「打开辩论室」 |
| 向前 seek | **pass**（服务端） | t_ms 前进正确；前端对齐同上 |
| 倒带 | **pass** | 重启式倒带回 `team_preview` 成功。本轮 **未复现**「必须手动点侧栏刷新」；硬刷新路径可对齐。疑点降级为：偶发 / 取决于是否仍挂着旧 SSE fold |
| 跨授权 seek | **pass**（服务端） | 越过 `team_preview` 时代确认；授权卡消失 |
| 前端同步 | **partial** | 导演通道只控节拍器+DB；截图实拍宜「直播回放 + 导演变速/暂停」，章节跳更适合掐点预览 |

### 执行层小修（脚本侧，非产品源码）

- 拍摄脚本改为默认生产构建 + `promo_lv` + 跳过 onboarding + 开拍清会话。
- 新增 `promo_capture_lv_molihua_director.mjs` / `fixup.mjs` / `speed1_clip.mjs`。
- 运行中后端曾无导演路由 → **重启 uvicorn 加载当前代码**后 `/v1/demo-tape/director` 可用（非代码 bug，是进程未更新）。

## 驱动脚本

| 脚本 | 用途 |
|---|---|
| `apps/desktop/scripts/promo_capture_lv_molihua.mjs` | 干净静帧全套（直播回放 · 生产构建） |
| `apps/desktop/scripts/promo_capture_lv_molihua_director.mjs` | 导演台功能验收 |
| `apps/desktop/scripts/promo_capture_lv_molihua_fixup.mjs` | 金句滚入视口 + 终审定点 |
| `apps/desktop/scripts/promo_capture_lv_speed1_clip.mjs` | SPEED=1 流式短片 |

## 复现（PowerShell）

```powershell
# 1) 后端（需含导演台路由的当前代码）
cd apps/server
$env:DEMO_TAPE_REPLAY_ENABLED='true'
uv run uvicorn agentcore.main:app --host 127.0.0.1 --port 8015

# 2) 生产前端（去 DEV）
cd apps/desktop
$env:VITE_API_URL='http://localhost:8015'
pnpm build:webapp

# 3) 干净账号（一次性）
cd apps/server
# DEV_USERNAME=promo_lv 等 — 或用既有 promo_lv / promopass（display_name=演示）

# 4) 拍摄
$env:PROMO_API='http://localhost:8015'
$env:PROMO_USER='promo_lv'; $env:PROMO_PASS='promopass'
node apps/desktop/scripts/promo_capture_lv_molihua_director.mjs
node apps/desktop/scripts/promo_capture_lv_molihua.mjs
node apps/desktop/scripts/promo_capture_lv_molihua_fixup.mjs
node apps/desktop/scripts/promo_capture_lv_speed1_clip.mjs
```
