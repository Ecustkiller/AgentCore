# 真机捕获产物

`pnpm video:capture full --tape <id>` 默认写到 `apps/video/assets/<tape-id>/`。

分层靠 **gitignore + 本文**；捕获脚本输出 `_video_tmp*` / `sequences/` / `stills/` / `clips/`。

| 层 | 典型路径 | 入仓？ | 语义 |
|---|---|---|---|
| 临时原始录屏 | `_video_tmp/`、`_video_tmp_clip/` | **否** | Playwright `recordVideo` 原始 webm，可重复生成 |
| 中间帧序列 | `sequences/` | **否** | 抽帧 / 推进序列等中间产物 |
| 精选交付物 | `stills/`、`clips/` | **否**（默认 gitignore；本地自备） | 分镜静帧与精选短片 |
| 元数据 | `MANIFEST.md`、`manifest.json` | **否**（含会话痕迹时勿提交） | 当次捕获报告 |

第三方商标若出现在画面里，归各权利人所有，仅作产品演示语境。
