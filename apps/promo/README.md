# apps/promo — AgentCore 宣传产线

> **双轨定界**：Remotion 合成与真机捕获素材是两条**并行产线**；成片靠外部剪辑合成。本仓库**不做** Remotion 消费真机素材的闭环，也**不**把 `assets/` 迁出 promo。
>
> **与 demos 的边界**：磁带回放属 [`demos/`](/demos/README.md)；宣传静帧、短片与 Remotion 套件属本目录。
>
> 片子选题 / 口播 / 分镜 / 成片时间轴不进仓——历程交给 git。

## 版权与素材

- Remotion 套件与代码：随仓库许可（[FSL-1.1-ALv2](/LICENSE)）。
- 内嵌字体：Inter / Noto Sans SC，见 [`src/core/fonts/NOTICE.md`](./src/core/fonts/NOTICE.md)（SIL OFL 1.1）。
- 真机捕获静帧/短片：**不入公开仓**（见 [`assets/README.md`](./assets/README.md)）。

---

## 一、Remotion 套件

可复用零件，不是一条成片。Studio 里按 `Kit-*` / `Still-*` / `PixelCheck` 打开。

| 零件 | 做什么 | 入口 |
|---|---|---|
| 壳 + 协作图 | 真组件 + 帧钟驱动的样图 | `src/core/` · `src/kit/hero/` · `Kit-GraphRun` |
| 打字发送 | 输入框逐字打任务并发送 | `Kit-ComposerSend` |
| 章节标题卡 | 数据驱动的幕标题 | `src/core/chapter/` · `Kit-Chapter` |
| Logo 锁 | 字标 + slogan，无 CTA | `Kit-Logo` |
| 像素校对 | 真 AgentNode 叠样图，对产品截图像素 | `PixelCheck` |
| 静帧套件 | 扇出 / 辩论 / 嵌套 / 壳 / 收束 | `src/stills/` · `pnpm stills` |

像素同源：共享 desktop `globals.css` + 叶子组件直复用 + chrome 脚手架 + ELK 布局预计算 + 内嵌字体。

样图改完重算坐标：`pnpm layout`（写出 `src/kit/hero/layout.ts`）。静帧 ELK：`pnpm stills:layout`。

```bash
pnpm dev     # Remotion Studio
pnpm still   # PixelCheck → out/pixel-check.png
pnpm stills  # Still 套件 → out/stills/
pnpm render -- Kit-GraphRun out/graph-run.mp4
```

新成片：用套件组时间轴，**不要**把选题/口播写进本目录。

---

## 二、真机捕获（任意磁带）

把一盘 [`demos/`](/demos/README.md) 磁带在生产 webapp + 导演台上回放，抽出静帧 / 短片。输出 `apps/promo/assets/<tape-id>/`。分层见 [`assets/README.md`](./assets/README.md)。

前提：后端 `DEMO_TAPE_REPLAY_ENABLED=true`（建议 `:8015`）；桌面已 `pnpm build:webapp`。入口在 `apps/desktop`：

```powershell
cd apps/desktop
$env:VITE_API_URL='http://localhost:8015'
pnpm build:webapp
$env:PROMO_API='http://localhost:8015'
pnpm promo:capture full --tape <tape-id>
```

`PROMO_API` 与构建时 `VITE_API_URL` 必须同为 `localhost`（勿混用 `127.0.0.1`）。`PROMO_PORT` 默认 `5174`。账号默认种子 `dev` / `devpassword`。

| 子命令 | pnpm | 角色 |
|---|---|---|
| `full` | `promo:capture:full --tape <id>` | 结构静帧 + 章节静帧 |
| `clip` | `promo:capture:clip --tape <id>` | SPEED=1 流式短片 + 抽帧 |

`full` 拍产品结构面（开场输入、开工卡、辩论室、协作图、导演台章节），**不**按某条片子的金句做内容门禁。

---

## 关联

- 磁带回放：[demos/README.md](/demos/README.md)
- 产品心智：[产品定位与品牌](/docs/01-产品/产品定位与品牌.md)
