# apps/video — AgentCore 视频仓库

> **定位**：片子的现行仓库。每条片子一个包（时间轴 + 口播 + Remotion composition）。套件是零件，给片子和静帧用。
>
> **双轨**：Remotion 合成与真机捕获并行。本仓库**不做** Remotion 消费真机素材的闭环，也**不**把 `assets/` 迁出本目录。成片 mp4 可仓外再压；**口播和镜次以仓为准**。
>
> **与 demos 的边界**：磁带回放属 [`demos/`](/demos/README.md)；静帧、短片、Remotion 套件与片子属本目录。
>
> 废稿、分镜日记、已换掉的金句不进包——历程交给 git。

## 版权与素材

- Remotion 套件与代码：随仓库许可（[FSL-1.1-ALv2](/LICENSE)）。
- 内嵌字体：Inter / Noto Sans SC，见 [`src/core/fonts/NOTICE.md`](./src/core/fonts/NOTICE.md)（SIL OFL 1.1）。
- 真机捕获静帧/短片：**不入公开仓**（见 [`assets/README.md`](./assets/README.md)）。

---

## 一、片子

`src/films/<id>/`：一条片子一个包。Studio 打开 `Film-*`。

| 片子 | 选题 | 状态 |
|---|---|---|
| `Film-Agent101` | Agent 科普 | 骨架（Logo + 主循环五拍）；口播 / 分镜未定 |

新片子：加文件夹 + 在 `src/films/manifest.ts` 登记。口播进 `copy.ts`（现行信息，跟 [产品定位与品牌](/docs/01-产品/产品定位与品牌.md)）。不要把选题写进 kit。

```bash
pnpm dev                              # Remotion Studio
pnpm render -- Film-Agent101 out/agent-101.mp4
```

---

## 二、套件与静帧

可复用零件。Studio 里按 `Kit-*` / `Still-*` / `PixelCheck` 打开。默认样图是**并行扇出**（一句话 → 三路队员 → CEO 汇总）。辩论是 `Still-debate`，不是 GraphRun 默认高潮。

| 零件 | 做什么 | 入口 |
|---|---|---|
| 壳 + 协作图 | 真组件 + 帧钟驱动的样图 | `src/core/` · `src/kit/hero/` · `Kit-GraphRun` |
| 打字发送 | 输入框逐字打任务并发送 | `Kit-ComposerSend` |
| 章节标题卡 | 主循环五拍 | `src/core/chapter/` · `Kit-Chapter` |
| Logo 锁 | 字标 + slogan，无 CTA | `Kit-Logo` |
| 像素校对 | 真 AgentNode 叠样图 | `PixelCheck` |
| 静帧套件 | 扇出 / 辩论 / 嵌套 / 壳 / 收束 | `src/stills/` · `pnpm stills` |

像素同源：共享 desktop `globals.css` + 叶子组件直复用 + chrome 脚手架 + ELK 布局预计算 + 内嵌字体。壳组件仍叫 `Promo*`（产品壳的像素副本），目录才是 `video`。

样图改完重算坐标：`pnpm layout`（写出 `src/kit/hero/layout.ts`）。静帧 ELK：`pnpm stills:layout`。

```bash
pnpm still   # PixelCheck → out/pixel-check.png
pnpm stills  # Still 套件 → out/stills/
pnpm render -- Kit-GraphRun out/graph-run.mp4
```

---

## 三、真机捕获（任意磁带）

把一盘 [`demos/`](/demos/README.md) 磁带在生产 webapp + 导演台上回放，抽出静帧 / 短片。输出 `apps/video/assets/<tape-id>/`。分层见 [`assets/README.md`](./assets/README.md)。

前提：后端 `DEMO_TAPE_REPLAY_ENABLED=true`（建议 `:8015`）；桌面已 `pnpm build:webapp`。入口在 `apps/desktop`：

```powershell
cd apps/desktop
$env:VITE_API_URL='http://localhost:8015'
pnpm build:webapp
$env:VIDEO_API='http://localhost:8015'
pnpm video:capture full --tape <tape-id>
```

`VIDEO_API` 与构建时 `VITE_API_URL` 必须同为 `localhost`（勿混用 `127.0.0.1`）。`VIDEO_PORT` 默认 `5174`。账号默认种子 `dev` / `devpassword`。旧名 `PROMO_*` 环境变量仍可读。

| 子命令 | pnpm | 角色 |
|---|---|---|
| `full` | `video:capture:full --tape <id>` | 结构静帧 + 章节静帧 |
| `clip` | `video:capture:clip --tape <id>` | SPEED=1 流式短片 + 抽帧 |

`full` 拍产品结构面（开场输入、辩论室、协作图、导演台章节），**不**按某条片子的金句做内容门禁。

---

## 关联

- 磁带回放：[demos/README.md](/demos/README.md)
- 产品心智：[产品定位与品牌](/docs/01-产品/产品定位与品牌.md)
