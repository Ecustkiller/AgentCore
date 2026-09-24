# 根级品牌素材

仓库根 `assets/` 只放**跨应用、与运行时无关**的品牌资源（图标、Logo 源文件等）。

| 放这里 | 不放这里 |
|--------|----------|
| 安装包 / 官网 / 文档共用的图标、设计稿导出的 PNG/SVG 母版 | 各 app 运行时静态资源 → 对应 `apps/*/public/` |

应用内引用品牌图时，从本目录复制或经构建脚本同步到目标 `public/`，**不要在各 app 各存一份未同步的副本**。

Orbit 桌面图标母版：`agentcore-icon-orbit-cropped.png`（满铺、四角不透明 → macOS 打包 `apps/desktop/build/icon-mac.png`）；`agentcore-icon-orbit-rounded.png`（四角透明 squircle → Windows/Linux 打包 `icon-win.png` 与运行时 `apps/desktop/resources/icon.png`）。改母版后二进制复制到上述路径，勿重生成失真图。

## Nexus 桌面图标（当前权威母版）

> 产品已改名为 Nexus，下面的母版取代了 Orbit 那套。Orbit 文件仅作回溯保留，**新构建不要引用**。

| 母版 | 用途 |
|------|------|
| `nexus-icon.svg` | **可编辑源文件**（1024 视口，三节点 + 连线几何，与 App 内 `BrandMarkIcon` 同源） |
| `nexus-icon-cropped.png` | 满铺、四角不透明 → macOS 打包 `apps/desktop/build/icon-mac.png` |
| `nexus-icon-rounded.png` | 四角透明圆角 → Windows/Linux 打包 `icon-win.png` + 运行时 `apps/desktop/resources/icon.png` |

改母版后**二进制复制**到下列路径（勿重生成失真图）：

```
apps/desktop/build/icon-mac.png                        ← nexus-icon-cropped.png
apps/desktop/build/icon-win.png                        ← nexus-icon-rounded.png
apps/desktop/resources/icon.png                        ← nexus-icon-rounded.png
apps/desktop/resources/icon-beta.png                   ← rounded + 色相偏转 + 「测」角标
apps/desktop/resources/channel-icons/icon-mac-beta.png ← cropped + 色相偏转 + 「测」角标
apps/desktop/resources/channel-icons/icon-win-beta.png ← rounded + 色相偏转 + 「测」角标
```

两种 alpha 变体的原因：macOS 会自己做圆角 mask，预圆角反而被裁切发糊；Windows 不做 mask，用满铺直角源会呈「方角块」。

Beta 通道图标由 `apps/desktop/scripts/generate-beta-icons.mjs` 派生（色相 + 「测」角标，**不重新设计品牌**）。该脚本依赖 `sharp`；若本机 `sharp` 不可用，可用等价的 Pillow 实现替代——注意 PIL 的 HSV 模式没有 alpha 通道，`convert("HSV")` 会吃掉圆角透明区，必须单独取出 alpha 再贴回。
