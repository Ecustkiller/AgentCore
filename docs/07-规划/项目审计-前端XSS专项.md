# 项目审计 · 前端 XSS 专项（第四轮）

> **状态**：✅ 本轮结案（3 端 HTML 注入面静态审计 + 关键链路核验；**4 条登记，全 P3 纵深加固，4/4 已落地**）。承接 [`项目审计-提示注入专项.md`](项目审计-提示注入专项.md)（第三轮，已结案）§七之四「后续专项」决策——与 PI-001 渲染面相邻，本轮合并深挖前端 XSS + 动态红队 PoC。
>
> **本文是什么**：前端 XSS 维度的**发现与登记册 + 修复落地记录**。沿用前三轮的严重度（P0–P3）与登记字段。
>
> **核心结论**：**渲染 sink 本身都已护住**——react-markdown 三端均无 `rehype-raw`、默认 `urlTransform` 拦 `javascript:`/`file:`/`data:`/自定义 scheme；mermaid `securityLevel:"strict"`(DOMPurify)；KaTeX `trust:false`；PI-001 已把模型图片降级为点击链接；admin 无 markdown/`innerHTML` sink。**未发现可脚本执行的 XSS**。本轮是 **Electron / CSP 纵深加固轮**：0×P0/P1/P2，4×P3，全部落地。
>
> **本轮已落地**：XSS-002（openExternal scheme 白名单，单源 `isSafeExternalUrl`）+ XSS-003（renderer sandbox）+ XSS-004（will-navigate 守卫）+ XSS-001（**三端全量 `script-src 'self'`**：Electron app:// 响应头 + web mobile/admin 经共享 `scripts/vite-csp.mjs` 插件注入，prod 严格 / dev 放 HMR）。新增 28 项单测（`safe-url.test.ts`，含红队 payload 全谱）。⚠️ **sandbox 翻转 + 严格 CSP 需 `pnpm dev` 冒烟一次**（代码无法静态验证渲染进程启动）；web 打包产物已构建核验（见 §五之一）。

---

## 一、范围与边界

**套餐**：以**前端 XSS / HTML 注入**为主——攻击者把可执行标记或危险 URL 藏进模型会输出、或外部数据会渲染的内容里，诱导前端在用户上下文执行脚本、或把危险 URI 交给系统。重点是 **Electron 桌面端**（渲染进程一旦被攻破，blast radius 含 preload IPC / 文件系统），兼顾 mobile / admin web。

**锚定**：当前 main 工作树（`apps/desktop/src` + `apps/mobile/src` + `apps/admin/src`）。自检用 Read，不与 git 对账。

**威胁模型**：信任「用户」（principal）；**不信任**任何经工具 / 渲染进入前端的外部内容（模型回复正文、web_search 结果 URL、工具结果、文件内容、队友文本）。XSS 有「模型 / 数据是否配合」的概率成分：定级以**平台可控的确定性半边**（渲染器是否净化、Electron 是否硬化、是否有 CSP 兜底）为锚。

**不在本轮**：
- 提示注入（第三轮已结案，见 `项目审计-提示注入专项.md`）——本轮只查「注入 → 前端脚本执行 / 危险 URI」这半边。
- preload IPC 权限面深挖（fs/sidecar IPC 是否过宽）——另一根轴（IPC 越权），单列。
- 后端 / 服务端 XSS（API 响应头、邮件模板等）——非前端面。
- 实操红队仅**本地 PoC 验证**（localhost 信标，不真外泄），不打真实目标。

## 二、审计维度（前端 XSS 镜头）

| # | 维度 | 查什么 | P0/P1 触发线 |
|---|---|---|---|
| X1 | HTML 注入 sink | `dangerouslySetInnerHTML` / `innerHTML` / `rehype-raw` / `srcdoc` / `eval` 是否吃未净化的外部内容 | 未净化外部内容直达 sink = **P0/P1** |
| X2 | Markdown 渲染链 | react-markdown 是否加 `rehype-raw`、`urlTransform` 是否被关、`a`/`img` 自定义组件是否漏净化 | 裸 HTML 透传 + 危险 scheme 可点 |
| X3 | 外链交付 | `target=_blank` / `shell.openExternal` 是否把攻击者可控 URL 的危险 scheme 交给系统 | 点击即启动本地处理器（Follina 类） |
| X4 | Electron 进程硬化 | `sandbox` / `contextIsolation` / `nodeIntegration` / `will-navigate` / 自定义协议 | nodeIntegration 开 + 无隔离 = **P0** |
| X5 | CSP 纵深 | 是否有 CSP 兜底任何未来 DOM-XSS（含 script-src / object-src / base-uri） | 高权限（Electron）零 CSP |

## 三、严重度 & 登记字段

沿用前三轮（见 `项目审计.md` §三）：

- 严重度：**P0 阻断** / **P1 高** / **P2 中** / **P3 低**。本轮 sink 均已护住，故登记项都是**纵深加固**（P3）：它们是「一旦出现脚本执行 XSS 时的严重度乘数」，本身不构成可利用漏洞。
- 登记字段：ID(`XSS-NNN`) / 维度(X1–X5) / 区域 / 位置(`路径:行`) / 描述 / 根因 / 严重度 / 建议 / 状态。

## 四、巡检序列

**X1 sink → X2 markdown 链 → X3 外链 → X4 进程硬化 → X5 CSP。**（先确认有没有「直达脚本执行」的真漏洞，再收纵深。）

---

## 五、登记册

| ID | 维度 | 区域 | 位置 | 描述 | 根因 | 严重度 | 建议 | 状态 |
|---|---|---|---|---|---|---|---|---|
| XSS-001 | X5 | 三端 | `desktop/src/main/index.ts`、`scripts/vite-csp.mjs`、`mobile/index.html`、`admin/index.html` | **全 app 无 CSP**：meta 与 Electron 响应头都无 Content-Security-Policy⇒ 任何未来 DOM-XSS 无纵深兜底，尤其 Electron 渲染进程权限高 | 从未引入 CSP（PI-001 曾标记 img-src 为后续） | P3 | 已落地（最正确设计）：**三端全量 `script-src 'self'`，不放 'unsafe-eval'/'unsafe-inline'**。Electron 走 app:// 响应头；web mobile/admin 走共享 `scripts/vite-csp.mjs`（prod 注入严格策略 + 关 modulepreload polyfill；dev 仅注入 object-src/base-uri 子集放行 HMR）。实测打包产物证明 mermaid 走 dynamic-import chunk、不需 eval | ✅ 已修（三端全量 strict） |
| XSS-002 | X3 | desktop main + renderer | `desktop/src/main/index.ts:104`、`renderer/.../SourceCards.tsx:140,196`、`toolResult/ToolResultView.tsx:128` | **openExternal 无 scheme 白名单**：`setWindowOpenHandler` 把 `details.url` 原样 `shell.openExternal`⇒ 任意 URI scheme 交给 OS。触发面是 `target=_blank` 锚点，其中 SourceCards/ToolResult 渲染 `href={c.url}`（web/工具结果 URL，**绕过 react-markdown 净化**）。点击危险 scheme（`file:`/`ms-msdt:`/自定义）即启动本地处理器（Follina 类，Windows） | 外链交付无 scheme 校验 + 原始不可信 URL 直进锚点 | P3（可达性低：卡片 URL 实为 http/https；但一旦可达即高危） | 已落地：新建 `@shared/safe-url` 的 `isSafeExternalUrl`（单源白名单 http/https/mailto），主进程 `setWindowOpenHandler` 仅放行白名单、其余 deny+记日志（单一接缝，覆盖所有桌面外链源） | ✅ 已修 |
| XSS-003 | X4 | desktop main | `desktop/src/main/index.ts:73` | **`sandbox:false`**：渲染进程未启用 OS 沙箱⇒ 渲染进程一旦被攻破，blast radius 不被沙箱收敛 | webPreferences 显式关沙箱（contextIsolation 默认开 / nodeIntegration 默认关，故非直 RCE） | P3 | 已落地：`sandbox:true`。preload 仅用 contextBridge+ipcRenderer（sandbox 兼容），API 面不变。⚠️ 需 `pnpm dev` 冒烟确认 IPC 正常 | ✅ 已修（需冒烟） |
| XSS-004 | X4 | desktop main | `desktop/src/main/index.ts:104` | **无 `will-navigate` 守卫**：主窗口可被导航离开 app://agentcore 源（如未来某 bug 触发顶级导航到攻击者源） | 仅靠 HashRouter 约定、无硬守卫 | P3 | 已落地：`will-navigate` 拦截一切离开 app 源（dev: Vite server）的顶级导航；外链仍走 setWindowOpenHandler | ✅ 已修 |

### 五之一 · 本轮修复落地

**XSS-002（外链交付）——单源 scheme 白名单（最高价值）**

- 新建 `apps/desktop/src/shared/safe-url.ts`：`isSafeExternalUrl(value)`——纯函数、零依赖，只放行 `http:` / `https:` / `mailto:`，相对 / 畸形 / 其余 scheme（`file:`/`javascript:`/`data:`/`ms-msdt:`/自定义）一律 false。`@shared` 别名让主进程与单测共享同一实现。
- `apps/desktop/src/main/index.ts`：`setWindowOpenHandler` 改为「白名单内才 `shell.openExternal`，否则 deny + `console.warn([security] blocked…)`」。**单一接缝**——所有桌面外链源（markdown 链接、PI-001 图片降级链接、SourceCards/ToolResult 卡片、设置页链接）都汇到这里，一处收口全覆盖，不在渲染层各打补丁（守「补丁绊线·勿同接缝多层」）。
- 残余：mobile/admin 浏览器端的原始锚点（引用卡 `href={source.url}`）理论上 `javascript:` 可点，但卡片 URL 实为 http/https（来自搜索 API），且无主进程接缝——列为 §七之三 的低优 DiD follow-up，不在本轮强改（避免给无 vitest 的 mobile 包加测试基建）。

**XSS-001（CSP 纵深）——三端全量 `script-src 'self'`（最正确设计）**

设计抉择（开发阶段、按最正确做、不打补丁）：在「A 全局放 `'unsafe-eval'` 让 mermaid 省事」「B 严格但 mermaid 降级成代码块」「C 严格 + 把 mermaid 动态能力隔离」之间，选 **最严的 `script-src 'self'`，不放 `'unsafe-eval'`**。理由：mermaid 图表源是**攻击者可影响**的（模型 / 间接注入可吐 ```mermaid 块），`'unsafe-eval'` 会把 eval/`new Function` 在**整个文档**放开——正好是恶意 mermaid 块把「解析图表」变成「主源代码执行」所需的原语。绝不为一个库的便利全局放开 eval。

**实测把「严格是否可行」钉死**（`apps/mobile` 打包产物，与桌面同一 mermaid 包）：
- 全 chunk **零** `new Worker(` / `createObjectURL` / 真 `eval(` / `new Function(`；
- 唯一的 `Function("…")` 构造器用法是 lodash 取全局的 `Function("return this")()`，在浏览器里被前面的 `self` 短路、**根本不执行**；
- 每种图表是普通**动态 `import()` 的 ES chunk**（`diagram-*.js`），从 `'self'` 加载——`script-src 'self'` 已覆盖，无需 eval。

落地：
- `apps/desktop/src/main/index.ts`：app:// 响应统一打 `Content-Security-Policy` 头（`script-src 'self'` + `worker-src 'self' blob:` + `object-src 'none'` + `base-uri 'none'` + `frame-ancestors 'none'` + `form-action 'self'` 等）。前提是 `electron.vite.config.ts` 关掉 Vite 的 inline modulepreload polyfill（否则注入 inline `<script>` 会被拦）。**只作用于 app://（prod）**，`pnpm dev` 经 loadURL 走 Vite server，HMR 不受影响。
- `scripts/vite-csp.mjs`（新建，mobile/admin 共享）：`transformIndexHtml` 按环境注入 meta——**prod 全量严格**（同上 script-src 'self' 套餐）、**dev 仅 object-src/base-uri 子集**（dev 下 plugin-react 注入 inline React Refresh preamble + HMR，强 script-src 会断热更）。两个 web 包 `vite.config.ts` 接插件并设 `build.modulePreload.polyfill=false`。
- `worker-src 'self' blob:` 为前瞻防御：当前 mermaid 不开 worker，但若未来版本把解析挪进 Web Worker，动态能力留在 worker 边界内，仍不必污染主文档 script-src。
- **兜底阶梯**（若未来 mermaid 改为主线程 eval）：升级为 mermaid `securityLevel:'sandbox'`（沙箱 iframe 隔离），**绝不**给 script-src 加回 'unsafe-eval'。
- **构建核验**：`apps/admin` + `apps/mobile` `pnpm build` 均 exit 0；产物 `dist/index.html` 内严格 CSP meta 就位、`<script>` 全为外链 module、**无 inline 脚本**（含 modulepreload polyfill）。

**XSS-003 / XSS-004（Electron 进程硬化）**

- `sandbox:true`（XSS-003）；`will-navigate` 拦截离开 app 源的顶级导航（XSS-004）。两者都在 `createWindow` 内，几行收口。

**验证**：新增 `apps/desktop/src/shared/__tests__/safe-url.test.ts`（**28 项**：放行 http/https/mailto + 大小写；拦 `file:`/`ms-msdt:`/`search-ms:`/`javascript:`(含大小写绕过)/`data:`/`vbscript:`/自定义/`chrome:`/`ftp:`/`tel:`；拦相对/畸形/protocol-relative/非字符串）。`pnpm exec vitest run src/shared/__tests__/safe-url.test.ts` → **28 passed**；改动文件 lint 清。

## 六、区域进度

| 维度 | 状态 | 小结 |
|---|---|---|
| X1 HTML 注入 sink | ✅ 良 | 三个 `dangerouslySetInnerHTML`（desktop/mobile mermaid、desktop MathBlock）均有真守卫：mermaid `securityLevel:"strict"`(DOMPurify)、KaTeX `trust:false`。无 `innerHTML`/`srcdoc`/`eval` 吃外部内容 |
| X2 Markdown 渲染链 | ✅ 良 | react-markdown v9/v10 三端均**无 `rehype-raw`**，**未覆盖 `urlTransform`**（默认拦 `javascript:`/`file:`/`data:`/自定义 scheme）；`a`/`img` 自定义组件不引入裸 HTML。PI-001 已把模型图片降级为点击链接 |
| X3 外链交付 | ✅ 已修 | **XSS-002 已修**——主进程 openExternal scheme 白名单（单源 `isSafeExternalUrl`），危险 scheme 一律拦 |
| X4 Electron 硬化 | ✅ 已修（需冒烟） | contextIsolation 默认开 + nodeIntegration 默认关（本就良）；**XSS-003 sandbox:true + XSS-004 will-navigate 守卫已加**；app:// 自定义协议有路径穿越守卫 + standard/secure 源 |
| X5 CSP 纵深 | ✅ 三端全量 strict | **XSS-001 已修**——三端全量 `script-src 'self'`（无 'unsafe-eval'/'unsafe-inline'）：Electron app:// 响应头 + web 共享 `vite-csp` 插件；实测 mermaid 走 dynamic-import chunk、不需 eval |

---

## 七、综合结论与处置

**总体**：3 端 HTML 注入面静态审计 + 关键链路核验完成，登记 **4 条：全 P3**，**零 P0/P1/P2**。与第三轮（提示注入，出了全审计第一条 P1）形成对照——**前端渲染层防御已成体系**（react-markdown 默认净化 + mermaid/KaTeX 安全配置 + PI-001 图片降级），本轮真正的缺口是 **Electron 进程硬化 + CSP 纵深**，均为「未来出 XSS 时的严重度乘数」，已一次性收口。

### 七之一 · 严重度分布

| 严重度 | 数量 | 条目 |
|---|---|---|
| P0 阻断 | 0 | — |
| P1 高 | 0 | — |
| P2 中 | 0 | — |
| P3 低 | 4 | XSS-001（无 CSP）**✅ 已修**、XSS-002（openExternal 无白名单）**✅ 已修**、XSS-003（sandbox:false）**✅ 已修**、XSS-004（无 will-navigate）**✅ 已修** |

> **本轮处置**：4 条登记 → **4 全修**。XSS-002 单源白名单（最高价值）；XSS-001 三端全量 strict CSP（`script-src 'self'`，无 'unsafe-eval'，实测 mermaid 不需 eval）；XSS-003/004 Electron main 几行硬化。新增 28 项单测兼红队 payload 谱。

### 七之二 · 共性主题

1. **「渲染层已护住，纵深与进程层是缺口」**——sink/markdown 链都安全，但 Electron 把 `sandbox`/CSP/导航守卫这些「纵深」长期留空。纵深的价值正是在「万一」时限制 blast radius。
2. **「原始 URL 绕过 markdown 净化」**——react-markdown 只净化 `[]()`/`![]()`，而 SourceCards/ToolResult 的 `href={c.url}` 是**程序化原始锚点**，不过 urlTransform——这类「数据直进锚点」要单独在交付出口（openExternal / safe-url 助手）收口。
3. **做得好的已成体系**——react-markdown 默认净化、mermaid strict、KaTeX trust:false、PI-001 图片降级、app:// 路径穿越守卫：前端安全已有骨架。

### 七之三 · 处置建议（优先级）& follow-up

- **✅ XSS-002（最高价值）已修**：openExternal scheme 白名单（单源 `isSafeExternalUrl`），覆盖所有桌面外链源。
- **✅ XSS-001 已修（升级为三端全量 strict）**：三端全量 `script-src 'self'`（无 'unsafe-eval'）——Electron app:// 响应头 + web 共享 `scripts/vite-csp.mjs` 插件（prod 严格 / dev 放 HMR）。原「web 需 nonce/hash 流水线」的 follow-up **已消解**：关掉 modulepreload polyfill 后产物无 inline 脚本，外链 module + 严格 script-src 即可，无需 nonce。
- **✅ XSS-003 / XSS-004 已修**：sandbox + will-navigate。
- **⚠️ 冒烟门（落地后必跑一次）**：`pnpm dev`（确认 sandbox:true 下 IPC 正常、渲染进程起得来）+ 运行 Electron 打包产物（确认 app:// 响应头 `script-src 'self'` 不致白屏）。web 端打包产物已构建核验（admin/mobile `pnpm build` 通过、产物无 inline 脚本）；桌面渲染进程启动仍需手动冒烟。
- **低优 DiD follow-up**：mobile/admin 浏览器端原始锚点（引用卡 `href={source.url}`）加 safe-url 校验（当前 URL 实为 http/https，风险近零）。
- **相邻轴（单列，不在本轮）**：preload IPC 权限面审计（fs/sidecar IPC 是否过宽）——它才是「渲染进程被攻破后能干什么」的真正边界。→ **已立项第五轮：见 [`项目审计-IPC权限面专项.md`](项目审计-IPC权限面专项.md)**（首扫完成，登记 1×P2〔execute op 无主侧门控 → 宿主 RCE〕+ 3×P3）。

### 七之四 · 动态红队 PoC（本地验证，不真外泄）

- `apps/desktop/poc/xss-beacon-listener.mjs`：localhost HTTP 信标监听器（仅 127.0.0.1，打印命中、不出网、不上报）。配套红队配方（脚本头注释）：
  - **A 渲染信标（PI-001）**：回复内 `![](http://127.0.0.1:9099/beacon?d=canary)` → 预期渲染为「图片链接」文字、**加载时不自动命中**监听器（只点击才走外链）。
  - **B 外链 / 危险 scheme（XSS-002）**：`[x](file:///…)` / `[x](ms-msdt:…)` → 预期被主进程白名单**拦截 + 记日志**；`[x](http://127.0.0.1:9099/click)` → http 放行（用户显式点击才命中，属预期）；`[x](javascript:…)` → 经 react-markdown urlTransform 置空、不可点。
  - **C 渲染 sink**：带 `<script>`/`onerror` 的 mermaid/KaTeX 源 → 预期 strict/trust:false 不产出可执行标记。
- **自动化回归**：`safe-url.test.ts` 的 28 项即「openExternal 白名单」的红队 payload 全谱（CI 可跑），把可利用性钉死在「危险 scheme 必拦」。
