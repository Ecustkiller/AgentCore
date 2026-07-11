# apps/promo — AgentCore 宣传片（Remotion 工程）

> **这是什么**：一支 30 秒横屏品牌片的成片产线 + **设计理由留档**。成片 100% 由本目录的 Remotion 工程渲染产出。
>
> **本 README 的职责**：只记「代码看不出来的东西」——路线取舍、被否方案、品牌 / 内容决策与理由。**画面、节奏、组件清单的事实以本目录代码为准**（`Video.tsx` 时间轴 / `scenes/` / `chrome/` / `graph/`）。
>
> **别搞混**：这支是「协作智能」主题的**脚本化复刻**品牌片；另有一支「谁更聪明」主题的**真录多模型辩论**视频（不同概念，未启动），见 [远期规划 §4.3](/docs/06-规划/远期规划.md)。

## 定档关键事实

① 30 秒**横屏**（16:9）、**仅横屏**；② 风格＝**真实产品演示**，与产品**像素一致**；③ 技术路线＝**纯 Remotion 复用真实组件**（「全 B」）；④ **亮色主题** + **桌面端外壳**；⑤ 字幕由本片产出、**BGM 用户后续自加**、无旁白；⑥ 片尾**无 CTA**（仅 Logo + slogan）；⑦ 字幕走「协作智能」品牌叙事；⑧ slogan＝「**AgentCore · 协作，是更高级的智能**」；⑨ demo＝5 层 DAG + 多方圆桌（11 Worker + 输入 / 汇聚点）。

## 目标与硬约束

- **目标**：30 秒、可投官网首页 / 社媒，让人 10 秒内 get 到 AgentCore 是什么、强在哪。
- **内容主线**：紧扣产品心智——**「真正的 Agent 团队协作」**（见 [产品定位与品牌](/docs/01-产品/产品定位与品牌.md)），让观众**亲眼看到一支 Agent 团队实时并行协作**。这是钩子，也是对标 Cursor / Claude 的差异点。
- **硬约束**：画面必须与真实产品**像素一致**。不接受文生图 / 手绘 mockup（给不了一致性），**只能渲染真实 UI**。

## 为什么选「全 Remotion 复用真组件」（决策 + 否决留档）

两条能做到「真实像素」的路：

| 方案 | 本质 | 像素一致 | 卡点控制 | 改版成本 | 真实性 |
|---|---|---|---|---|---|
| A · 截真机（Playwright） | 脚本驱动真应用录屏 / 逐帧截图 | ★ 天然 100% | 弱：难做帧级定格 / 缓动 | 高：改一次常要重跑 + 重录 + 重剪 | ★ 最硬（产品本体） |
| **B · Remotion 复用真组件** ✅ | `import` 真组件 + 同套 token 逐帧渲染成 MP4 | 同源（chrome 需忠实重建） | ★ 逐帧时间轴，卡点 / 缓动 / 变速随意 | ★ 改个 prop 重渲，确定性输出 | 真组件，属「复刻」 |

**决策＝全 B**。理由：宣传片必然反复改版（换文案 / 换主题 / 出竖屏 / 出英文），且 30s 的生死在「帧级卡点」；B 在这两点压倒性占优，并且全程 100% 代码、一条管线、版本可控。B 的唯一代价（忠实重建 chrome + 一次像素核对）已在落地时消除。

> **被否＝全 A**：真实性最硬，但帧级卡点难、改版贵、还需额外做 mock SSE 演出 harness + 另开剪辑器。A 截图**降级为「像素标尺」**（落地时用来比对，不进成片，见 `PixelCheck` composition）。

## 像素同源怎么做到的（5 个关键设计点的「为什么」）

1. **共享同一套样式层（根基）**：Remotion 工程 `@import` 真实 [`globals.css`](/apps/desktop/src/renderer/styles/globals.css)（Tailwind v4 + `@xyflow/react` 样式 + OKLCH `:root`/`.dark` token，品牌色 hue 255）+ 镜像 Tailwind 配置 → 颜色 / 间距 / 圆角 / 阴影全部同源。见 `src/styles.css`。
2. **叶子组件直接复用**：`AgentNode` / `EndpointNode` / `StepEdge` / 消息气泡 等都是 `data`/props 驱动的纯展示件，像素从真组件来。
3. **chrome 搭脚手架而非启整页**：`GraphView` / `Sidebar` / `ChatView` 这些容器读了一堆 zustand store / react-query / 路由 / IPC，直接搬整页会被依赖绊住。做法＝**外层 flex 脚手架按原样重述 + 内容填真叶子组件**（脚手架除 border/bg token 外无独有像素，重述零风险）。见 `chrome/`。
4. **ELK 布局预计算成常量**：`computeLayout` 是异步的；demo 数据固定，故把节点坐标算一次写成常量 → 渲染零异步、完全确定。见 `data/layout.ts` + `scripts/`。
5. **运动从「帧钟」重驱（唯一真成本）**：产品动画是 CSS 壁钟动画（节点入场、running 脉冲、完成绿闪、粒子流、打字光标），在 Remotion 里不能靠壁钟（不跟帧同步、渲染不确定）。改由 `useCurrentFrame()` 驱动：节点按帧错峰入场、`status` 按帧翻转、粒子位置 / 流式文字按帧切片。**复用组件的「长相」，重编排它的「运动」**——这正是换来帧级卡点的代价。见 `motion/primitives.ts`。

> **唯一会「漂移」的点＝字体**：产品用系统字体，无头渲染时机器字体不同会致字形差异。解法＝**内嵌固定 webfont**（Inter + Noto Sans SC 打进工程，`delayRender` 等字体加载完再渲），每次渲染像素相同。见 `fonts.ts` + `src/styles.css`。

## 30 秒分镜意图（钩子 + 字幕叙事线）

> 帧级时间轴、镜头切分、各段时长的**事实以 `Video.tsx` + `scenes/` 为准**；这里只留「为什么这么排」。

- **核心钩子**＝「**一支真正并行协作的团队，实时可见**」。11–20s 是全片灵魂；那些动画（节点级联入场、running 脉冲、粒子流入边、完成绿闪）**产品里本来就有**，全 B 只是在 30s 时间轴上重新编排。
- **字幕叙事线**＝全片不做功能描述，而用品牌核心理念「协作，是更高级的智能」的完整论证链作字幕：哲学开题（人类文明靠协作）→ 类比 AI → 画面论证（团队并行跑起来）→ 品牌锁定。**字幕讲「为什么」，画面演「是什么」**。
- **demo DAG**（11 Worker 节点，5 层）：L1 并行调研 ×3 → L2 主持人定题 → L3 四方圆桌交锋（修订 overlay 对射）→ L4 策略定稿 → L5 并行产出 ×2。一次展示并行扇出 / 波次调度 / 圆桌辩论 / 交叉修订 / 二次扇出全部核心编排能力。

## 内容 / 品牌决策（理由留档）

| 决策点 | 结论 |
|---|---|
| 主题 | **亮色**（产品两套主题都有，B 里不切 `.dark` 即默认亮色） |
| 外壳 | **桌面端外壳**（含应用 `TitleBar` 窗口控件 + 侧栏），非 web |
| 声音 | **字幕由本片产出**；**BGM 用户后续自加**；无旁白配音 |
| 多版本 | **仅横屏 16:9**，不出竖屏；英文版暂不 |
| 内嵌字体 | **Noto Sans SC + Inter**（默认，低风险可改） |
| 帧率 | **30fps**（默认，运动多想更顺可改 60） |
| 结尾 | **不做 CTA 落点**，片尾仅 Logo + slogan |
| 字幕叙事线 | 全片统一走「协作智能」品牌理念叙事（字幕讲故事、画面展示功能） |
| slogan | **AgentCore · 协作，是更高级的智能**（片尾收口，与官网品牌统一） |
| demo 任务 | **5 层 DAG + 多方圆桌**：用户输入「做个完整的产品规划，多方论证后定方案」→ CEO 编排 11 Worker DAG（3 并行调研 → 主持人 → 四方圆桌 → 策略定稿 → 2 并行产出） |

## 产品与功能映射（宣传片素材来源）

> 本片**只演协作编排核心**，不覆盖记忆 / 工作区 / 手机端 / 计费 / 法律垂直等——那些由 still 或后续素材补。

| 时间段 | 画面 | 对应产品能力 | 事实来源 |
|---|---|---|---|
| 0–7s | 空态 → 打字 → 发消息 | 基础聊天、CEO 接单 | `OpeningScene` |
| 7–20s | 协作图级联入场 + 五波执行 | DAG 调度、并行扇出、圆桌辩论、波边界 | `data/demo.ts` + `graph/graphState.ts` |
| 20–24s | 汇聚点亮 + 流式答复 | CEO 汇总、SSE 流式输出 | `RunScene` |
| 24–27s | 三形态快闪 | 并行 / 辩论 / 嵌套委派（各一图） | `data/scenarios.ts` |
| 27–30s | Logo + slogan | 品牌收口 | `LogoScene` |

**本片刻意不演**（避免 30s 信息过载）：检查点卡片细节（`PromoCanvas` 指挥台仅在 still 出现）、工作区文件、记忆更新、手机端、多模型真辩——见 still 套件或 [远期规划 §4.3](/docs/06-规划/远期规划.md)。

**Still 套件**（`pnpm stills` → `out/stills/`）：`fanout` 并行扇出 · `debate` 圆桌辩论 · `nested2` 多层嵌套 · `bigteam` 团队协作全景 · `appshell` 真桌面壳 · `nodecard` 节点特写 · `mobile` 手机端。

## 为什么独立成工程 + 与 desktop 同源

本工程与 `apps/desktop` 平级，核心设计接缝＝**只读复用 desktop 渲染层的组件与样式**（共享 `globals.css` + 镜像 Tailwind、内嵌字体、预计算 ELK 坐标）。

**为什么这么搭**：desktop 升级组件 / token 时宣传片**自动同源**重渲——这是「全 B」相对截图方案的长期优势，也是「宣传片必然反复改版」前提下选它的根因。

## 工程结构（以代码为准）

- `Root.tsx` —— Remotion compositions 注册（成片 `Promo` + 像素核对 `PixelCheck` + 各 still）
- `Video.tsx` —— 成片主时间轴
- `scenes/` —— 分段镜头（`OpeningScene` / `RunScene` / `ScenarioScene` / `LogoScene` + `Subtitles`，及若干 still 场景）
- `chrome/` —— 桌面外壳脚手架（`PromoShell` / `PromoCanvas` / `ChatBits`）
- `graph/` —— 协作图（`GraphStage` / `PromoNodes` / `PromoFlowEdge` / `graphState`，在 desktop 渲染层组件 + 样式之上做帧驱动编排）
- `motion/primitives.ts` —— 帧驱动运动原语
- `data/` —— demo / 场景 / 预计算布局等固定数据
- `fonts.ts` —— 内嵌字体加载
- `scripts/` —— ELK 坐标预计算等

## 渲染 / 预览 / BGM

在 `apps/promo` 内运行（脚本以 `package.json` 为准）：

```bash
pnpm dev     # Remotion Studio 预览
pnpm build   # 渲染成片 → out/promo.mp4
pnpm still   # 像素核对静帧 → out/pixel-check.png
```

> **加 BGM**：见 [`public/README.md`](./public/README.md)（放 `bgm.mp3` + 把 `Video.tsx` 的 `BGM_FILE` 由 `null` 改为文件名再重渲）。

## 关联

- 产品差异化（内容主线来源）：[产品定位与品牌](/docs/01-产品/产品定位与品牌.md)
- 协作图 / 节点 / 状态语义（分镜素材的事实来源）：[前端UX设计](/docs/04-前端/前端UX设计.md)、[编排器与CEO主Agent](/docs/03-AI核心/编排器与CEO主Agent.md)
- 另一支视频（不同概念，未启动）：[远期规划 §4.3 「谁更聪明」多模型辩论视频](/docs/06-规划/远期规划.md)
