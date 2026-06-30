# 项目审计 · preload IPC 权限面专项（第五轮）

> **状态**：✅ 全数闭环（5 维 IPC 暴露面静态审计 + 关键链路核验；**4 条登记：1×P2 + 3×P3，零 P0/P1，4/4 已修**〔2026-06-30：IPC-003 删未用通用桥；IPC-004 IPC 缝补薄运行时入参校验；**IPC-001/002 = RCE 两头，主侧 native 确认门已落地**——`execute` spawn 前每次必弹、`openPath` 仅对可执行/脚本类型弹、安全类型直开零打扰〕）。承接 [`项目审计-前端XSS专项.md`](项目审计-前端XSS专项.md)（第四轮，已结案）§七之三「相邻轴（单列，不在本轮）」决策——第四轮把渲染层 + Electron 进程硬化收完后**专门点名**：「preload IPC 权限面审计（fs/sidecar IPC 是否过宽）——它才是『渲染进程被攻破后能干什么』的**真正边界**」。本轮专攻这道边界。
>
> **本文是什么**：preload / IPC 权限面的**发现与登记册**。沿用前四轮的严重度（P0–P3）与登记字段。
>
> **与前几轮不同的处置**：IPC-001/002 的门控方案触及「本地优先 execute」的 UX 与架构（属 `dev-process`「AI 提案 → 人确认」），故本轮**先发现 + 登记、再经人拍板方案后落地**（不像 2/3/4 轮顺手修）。**门控方案经人决策（2026-06-30）：执行前 native 确认对话框**——renderer 无法伪造的主侧最后一道门，最小侵入、不破坏本地优先体验；**已落地**（`main/fs/execGate.ts`：execute 每次必弹、openPath 仅可执行/脚本类型弹，+6 单测全绿、零契约改动）。
>
> **核心结论**：**文件系统 IPC 的路径与授权边界做得很强**——根显式授权 + `resolveLexical`/`realInside` 双重守卫（与服务端 `resolve_safe_path` 同源），**无路径穿越**。但本轮命题「渲染进程被攻破后能干什么」的答案是：经 `fs:workspaceOp` 的 **`execute` op 可达宿主任意代码执行（RCE），且主进程侧零门控**——这是全系列**最大爆炸半径**的面。因前置较高（需 renderer 完整 JS 被攻破，第四轮无 live 脚本执行 XSS；SSE 路径另有服务端审批门）而**潜伏、不可今日点爆**，定 P2。**〔2026-06-30 已加固〕**：该面已补主进程侧 native 确认门（renderer 无法伪造）——`execute` spawn 前每次必弹、`openPath` 仅对可执行/脚本类型弹，把「击穿后即 RCE」堵在最后一道原生出口。

---

## 一、范围与边界

**套餐**：以 **Electron 桌面端 preload / IPC 权限面**为主——渲染进程经 `contextBridge` 拿到哪些能力、主进程 `ipcMain` 句柄是否对 renderer 入参过度信任、一个被攻破的渲染进程能把这些能力升级成什么（任意文件读写 / 命令执行 / 原生能力滥用）。这是「渲染进程被攻破后的爆炸半径」边界。

**锚定**：当前 main 工作树（`apps/desktop/src/{main,preload,shared}`）。自检用 Read，不与 git 对账。

**威胁模型**：信任「用户」（principal）；**威胁主体 = 被攻破的渲染进程**（前四轮的注入 / XSS 链路一旦被利用、或渲染层依赖被投毒后，攻击者在 renderer 内可执行任意 JS）。本轮问的不是「renderer 会不会被攻破」（那是 1–4 轮的事），而是「**假定它被攻破，IPC 这道墙能挡住多少**」——以**平台可控的确定性半边**（主进程是否对危险能力设结构性门控）为定级锚。

**不在本轮**（避免发散）：
- 前端 XSS / 注入本身（1–4 轮已覆盖）——本轮只查「拿到 renderer 执行权之后，IPC 面给多大权限」。
- sidecar JSON-RPC **协议健壮性**深挖（行分帧 / id 配对 / 撕裂帧）——已部分单测（`__tests__/sidecar-client.test.ts`），非权限面。
- mobile / admin 原生桥——mobile 无本地 FS / exec（`cross-platform-frontend.mdc`：手机不建本地文件 / MCP），面小，另议。
- 后端 / 云侧鉴权（第二轮安全专项已覆盖）。

## 二、审计维度（IPC 权限面镜头）

| # | 维度 | 查什么 | P0/P1 触发线 |
|---|---|---|---|
| I1 | 通道暴露面 / 最小权限 | `contextBridge` 暴露哪些命名空间；是否暴露了用不到的泛化能力（通用 `ipcRenderer` / `webFrame`） | 暴露可调任意主进程能力的泛化桥 = P2 起 |
| I2 | 文件系统 IPC | 路径穿越 / 符号链接逃逸 / 根授权 / 能力范围（读写删移） | 逃出授权根、任意路径读写 = **P0/P1** |
| I3 | 进程 / 命令执行面 | `execute` op、`openPath`、sidecar spawn 的 cmd/args 是否 renderer 可控、是否有主侧门控 | 渲染进程可经 IPC 驱动**宿主任意代码执行**而无主侧门控 = **P1**（潜伏则 P2） |
| I4 | 输入校验 | renderer 入参是否在主进程边界做运行时校验，还是直接信任 TS 断言 | 边界零校验且下游无守卫 = P1 |
| I5 | 其它原生能力 | updater（更新源 / 熔断）、clipboard、dialog、log、window 控制 | 可被 renderer 导向投毒更新 / 任意写盘 = P1/P2 |

## 三、严重度 & 登记字段

沿用前四轮（见 `项目审计.md` §三）：

- 严重度：**P0 阻断** / **P1 高** / **P2 中** / **P3 低**。权限面有「renderer 是否真被攻破」的前置成分：定级以**平台可控的确定性半边**（主进程是否对危险能力设结构门控）为锚，renderer 被攻破的前置可达性作为可利用性修正。
- **与第四轮的定级一致性**：全系列唯一的 P1（PI-001 渲染信标）之所以是 P1，是因为它**仅需提示注入、无需 renderer 被攻破即静默触发**（渲染器自动加载远程图）；本轮 IPC-001 的触发前置**更高**（需 renderer 完整 JS 被攻破，或走服务端已审批的 SSE 路径），故虽爆炸半径更大（RCE > 外泄），按同一把尺定 **P2 潜伏**而非 P1。
- 登记字段：ID(`IPC-NNN`) / 维度(I1–I5) / 区域 / 位置(`路径:行`) / 描述 / 根因 / 严重度 / 建议 / 状态。

## 四、巡检序列（价值密度，皇冠明珠先）

**I3 执行面 → I2 文件系统 → I1 暴露面 → I4 输入校验 → I5 其它原生能力。**

（「渲染进程能否经 IPC 驱动宿主代码执行 / 任意文件读写」是本面最可能出真·高危的两处，最先扫。）

---

## 五、登记册

| ID | 维度 | 区域 | 位置 | 描述 | 根因 | 严重度 | 建议 | 状态 |
|---|---|---|---|---|---|---|---|---|
| IPC-001 | I3 | desktop/main | `fs/workspace/exec.ts`、`fs/ipc.ts:166`(workspaceOp)、`fs/workspace/dispatch.ts:93` | **`execute` op = 无主侧门控的宿主 RCE**：`fs:workspaceOp` 的 `execute` 直接 `spawn(python/node/bash, [脚本文件], {cwd:授权根})` 跑 renderer 传入的任意 `code`，**以 app/用户全权限、无沙箱、无主进程侧审批**。该 handler **独立可调**——不校验任何回合 / 审批状态，只需一个已授权根（默认 `ensureDefaultRoot` 建的 `~/Documents/AgentCore` 即满足）。门控**全在上游**：① renderer 完整性、② 服务端对 `code_execute` 的审批（仅挡 SSE `workspace_op_required` 路径）。被攻破的 renderer 直接 `window.fsApi.workspaceOp(rootId,'execute',{language:'bash',code})` → **宿主 RCE，零门控**，完全绕过服务端审批 | 主进程把「执行任意代码」这一最危险原语**原样委派**给 renderer；信任边界（主进程）未对它设结构性门控，依赖上游约定 | **P2（潜伏 · 全系列最大爆炸半径）** | 把 `execute`（及 IPC-002 的 write→openPath）门控**下沉主进程**——renderer 无法伪造的原生确认（执行前 native dialog），或绑定到主进程铸的、与已审批 SSE 流配对的一次性能力票，或默认关 + 显式开关（参照 SEC-005 启动硬守卫思路）。**勿**只靠 renderer/服务端。缓解前置：execute 需目标机 PATH 有解释器（打包端用户未必有 python/node） | ✅ 已修（2026-06-30：选方案 (A)。新增 `fs/execGate.ts`，`fs/ipc.ts` workspaceOp 句柄在 `op==='execute'` 时 spawn 前过主侧 native 确认——renderer 无法伪造；**每次必弹、不记忆**，与后端 `code_execute` PER_CALL/PI-004 同姿态；取消 → 回 `opErr("ExecutionDenied")`（云端 execute 工具据此报失败，未知 kind 在后端 channel 退化为 `WorkspaceIOError` 并保留 detail）。默认/取消按钮均落「取消」位（安全失败）。+6 单测，typecheck/vitest 全绿、零契约改动） |
| IPC-002 | I3 | desktop/main | `fs/shell.ts:27` `openWithDefaultApp`（`shell.openPath`）、`fs/ipc.ts:179` | **openPath 可执行类型 = 第二个 RCE 头**：`fs:openPath` 对授权根内**任意文件类型**走 OS 默认关联打开。被攻破的 renderer 可先 `workspaceOp write` 一个 `.bat`/`.command`/`.desktop`/`.lnk`/`.hta`/`.scr` 再 `openPath` 它 → 经文件关联**执行代码**（**无需解释器**，区别于 IPC-001）。路径已限授权根 + realpath 校验，但**无可执行扩展名黑名单**。是 IPC-001 之外**独立、可绕过「只门控 execute」修复**的第二条 RCE 路径 | openPath 把「打开」无差别交给 OS，未区分文档 / 媒体 vs 可执行 / 脚本类型 | P3（与 IPC-001 同前置 = 需 renderer 被攻破、爆炸半径被 IPC-001 覆盖；但**若只修 execute 不修这条则门控形同虚设**） | openPath 加**安全类型白名单 / 可执行扩展名黑名单**（参照 XSS-002 的 `isSafeExternalUrl` 单源做法），或与 IPC-001 同一 native 确认门；**须与 IPC-001 一并修**。`reveal`(showItemInFolder) 仅高亮、`copyPath` 仅写剪贴板——不受影响 | ✅ 已修（2026-06-30：与 IPC-001 同门。`execGate.isExecutablePath` 黑名单分类可执行/脚本扩展名（exe/bat/cmd/ps1/sh/command/lnk/hta/desktop/jar… 大小写无关、无扩展名与 dotfile 放行），`fs/ipc.ts` openPath 句柄仅对命中类型弹主侧确认、安全类型（文档/媒体）直开零打扰；取消 → 回 `{ok:false}`。分类为纯函数、单测覆盖；与 IPC-001 同一 commit 落地） |
| IPC-003 | I1 | desktop/preload | `preload/index.ts:109` | **暴露未用的通用 electronAPI**：`contextBridge.exposeInMainWorld("electron", electronAPI)` 暴露 @electron-toolkit 的**泛化 electronAPI**（通用 `ipcRenderer` send/invoke/on/removeAllListeners 任意通道 + `process`/`webFrame`），但 renderer **从未使用 `window.electron`**（全仓 0 引用）。今日**不增**新通道可达性（所有业务通道已由 5 个有类型命名空间暴露），但违反最小权限：给被攻破的 renderer 一个对任意通道 `on`/`removeAllListeners` 的泛化把手 | 脚手架默认暴露 electronAPI，未按本应用实际所需收敛 | P3 | 删除 `electron`/electronAPI 暴露（只留 `fsApi`/`sidecarApi`/`updaterApi`/`logApi`/`windowApi` 五个有类型窄面），或裁到确需子集；改后回归一次启动 | ✅ 已修（2026-06-30：删 `@electron-toolkit/preload` import + 隔离/非隔离两分支共 3 处 `electron` 暴露；renderer 全仓 0 引用、`env.d.ts` 本就未声明 `window.electron`，preload lint 清） |
| IPC-004 | I4 | desktop/main | 全部 `ipcMain.handle` 入参（`fs/ipc.ts`、`sidecar-service.ts`、`updater.ts`、`log-service.ts`） | **IPC 缝无运行时入参校验**：所有 handler 把 renderer 入参**直接 TS 断言**为目标形状（`p: {rootId, relPath}` 等），无运行时校验；安全完全靠**下游守卫**（路径守卫 / dispatch `default` / log sanitize）兜底。今日下游守卫成立（畸形入参 → 未授权 / 越界 / 未知 op），**无可利用缺口**，但边界本身未结构化校验——未来某 handler 漏接下游守卫即裸奔 | IPC 缝无统一入参契约校验层，校验是「下游偶然」而非「边界结构」 | P3 | IPC 缝加一层薄运行时校验（zod/valibot 或手写守卫），让边界校验成结构而非依赖下游；与 IPC 契约类型同源 | ✅ 已修（2026-06-30：新增 `main/ipc-validate.ts` 薄校验层 `requireStringFields`/`assertShape`——**手写守卫、零新依赖**；`fs/ipc.ts` 全句柄边界先校验寻址类字段、畸形按契约回 `{ok:false}`/`invalidWriteResult`/`opErr`；`sidecar-service.ts` 6 句柄、`updater.ts` configure 边界校验后才入业务（畸形 → reject / 忽略）；`app:log` 入参本由下游 `sanitize()` 结构化覆盖、无需改。+9 单测，typecheck / vitest 全绿、**零契约改动**） |

> **META 结论（本轮主题）**：IPC-001 / 002 是**同一根因的两个头**——主进程是「服务端 / 引擎 workspace op 的**哑执行器**」，信任链 = 服务端(TLS) + renderer 忠实转发，**renderer 是弱环**。前四轮已把 renderer 当不可信内容边界来硬化（注入框定 / XSS 渲染层 / Electron 进程沙箱）；本轮发现：**一旦 renderer 这道防线被击穿，IPC 面会把它直接放大成宿主 RCE**，因为最危险的两个原语（`execute`、`openPath` 可执行类型）在主进程侧**零结构门控**。修复方向是把门控**下沉到主进程**（renderer 不可伪造），而非继续依赖「renderer 不被攻破」这个假设。**〔2026-06-30 已落地〕** `main/fs/execGate.ts` 在 IPC 缝两个出口各加了这道 renderer 无法伪造的主侧门：execute 每次必弹、openPath 仅对可执行/脚本类型弹——同根的两个头一并堵上。

---

## 六、区域进度

| 维度 | 状态 | 小结 |
|---|---|---|
| I1 通道暴露面 | ✅（IPC-003 已修） | 原 6 个 `exposeInMainWorld`，含通用 `electron`（未用）；**IPC-003 已删通用桥**，现收敛为 5 个**有类型窄面**：`fsApi`/`sidecarApi`/`updaterApi`/`logApi`/`windowApi`。`contextIsolation`（默认开）+ `nodeIntegration`（默认关）+ `sandbox:true`（XSS-003）已立——preload 仅用 contextBridge + ipcRenderer，sandbox 兼容 |
| I2 文件系统 IPC | ✅ 强（无 P0/P1） | 根**显式授权**（`addRoot` 走 dialog / `ensureDefaultRoot` 建 `~/Documents/AgentCore`），绝对路径**只在主进程**、从不下发 renderer。**所有路径 op** 过 `resolveLexical`（拒 `..`/绝对/同名兄弟，词法不触盘）+ `realInside`/`resolveWritable`（realpath 复核防符号链接逃逸），与服务端 `resolve_safe_path` 同语义；目录遍历**不跟随 symlink**（防环路 / 越界）；`isValidName` 拒 `/`·`\`·`.`·`..`；写为原子 tmp+rename + CAS。**无路径穿越**——能力限授权根内（读 / 写 / 删 / 移 / 复制 / 重命名为本地工作区应有功能，非缺陷） |
| I3 进程 / 命令执行 | ✅（IPC-001/002 已修） | 原 `execute` op = 无主侧门控的宿主任意代码执行（**IPC-001，P2**，全系列最大爆炸半径）、openPath 可执行类型（**IPC-002，P3**）；**已补主侧 native 确认门**（`fs/execGate.ts`，renderer 无法伪造）：execute spawn 前每次必弹、openPath 仅对可执行/脚本类型弹、安全类型直开。**原本就做得好**：sidecar spawn 的 cmd/args **非 renderer 可控**（dev=venv python / 打包=内置 CPython 绝对路径 / `AGENTCORE_SIDECAR_CMD` 是**环境变量**非 IPC 入参）；execute 走 **argv 数组**（无 `shell=true`/拼接）、超时强杀、临时目录隔离脚本文件、cwd 限授权根；sidecar 回合的危险工具另有服务端审批门（`SIDECAR_APPROVALS_ENABLED=true`） |
| I4 输入校验 | ✅（IPC-004 已修） | 原 IPC 缝无运行时校验、靠下游守卫；**IPC-004 已补**薄边界校验层（`main/ipc-validate.ts`，手写守卫零依赖）：寻址 / 标识类字段在边界即校验，畸形入参按各句柄契约拒绝（fs 回判别式失败、sidecar reject、updater 忽略），log `app:log` 本由 `sanitize()` 覆盖。校验从「下游偶然」升为「边界结构」 |
| I5 其它原生能力 | ✅ 良（无 P0/P1） | **updater**：更新源走 build-config（`app-update.yml`）+ 代码签名，renderer 仅经 `configure` 设熔断 **policy** 基址（`GET ${base}/updates/policy`，**fail-open**）——**非投毒 / RCE 面**（顺带一处可忽略的 main 侧 SSRF：policy GET 任意 baseUrl，但 renderer 本就能自行 fetch 任意 URL，零增量）。**log**：`app:log` 单向 send，sanitize level/event、固定路径 `userData/logs/desktop.jsonl`、5MB×2 滚动有界（最多刷 10MB，无路径注入）。**clipboard/dialog/reveal**：写剪贴板 / 系统选目录 / 文件管理器高亮，无危险。**window:\***：minimize/maximize/close 平凡 |

---

## 七、综合结论与处置（首扫）

**总体**：5 维 IPC 权限面静态审计 + 关键链路核验完成，登记 **4 条：1×P2 + 3×P3**，**零 P0 / 零 P1**。与第四轮形成接力——第四轮把 renderer 这道防线（注入框定 + XSS 渲染层 + Electron 进程沙箱）硬化到「无 live 可利用 XSS」；本轮回答它点名的下一问「**万一防线被击穿，IPC 墙挡多少**」：**文件边界一流（无穿越），但执行面是缺口**——`execute` op 给被攻破的 renderer 一条直达宿主 RCE 的零门控通道（IPC-001），openPath 是其第二个头（IPC-002）。两者今日**潜伏不可点爆**（需 renderer 完整 JS 被攻破，第四轮无此 live 向量；SSE 路径服务端审批门控；execute 还需 PATH 有解释器），但**爆炸半径全系列最大**，是首要加固候选。**〔2026-06-30 全数闭环〕**：IPC-003 删通用桥、IPC-004 补 IPC 缝边界校验层；IPC-001/002 经人拍板后落地主侧 native 确认门（`fs/execGate.ts`：execute 每次必弹 + openPath 可执行/脚本类型弹、安全类型直开）——执行面这道缺口已堵在最后一道原生出口。

### 七之一 · 严重度分布

| 严重度 | 数量 | 条目 |
|---|---|---|
| P0 阻断 | 0 | — |
| P1 高 | 0 | — |
| P2 中 | 1（**✅ 已修**） | IPC-001（execute op 无主侧门控 → 宿主 RCE，潜伏 · 最大爆炸半径；**已补主侧 native 确认门**） |
| P3 低 | 3（**✅ 全已修**） | IPC-002（openPath 可执行类型，第二 RCE 头，**✅ 已修** · 与 IPC-001 同门）、IPC-003（通用 electronAPI 未用，**✅ 已修**）、IPC-004（IPC 缝无运行时校验，**✅ 已修**） |

### 七之二 · 共性主题

1. **「主进程是哑执行器，renderer 是弱环」**——IPC-001/002 同根：危险原语（执行 / 打开可执行文件）原样委派给 renderer，信任链依赖「renderer 不被攻破」这个**假设**而非主进程的**结构门控**。前四轮越是把 renderer 当不可信边界硬化，本轮这条「击穿后即 RCE」的放大通道就越该堵在主进程侧——**2026-06-30 已堵**（`execGate` 主侧 native 确认门，renderer 无法伪造）。
2. **「守卫建在了正确的层（路径）、缺在了危险的层（执行）」**——文件路径穿越守卫一流（与服务端同源、realpath 防符号链接），但「交给 OS 跑」的出口（execute、openPath-of-file）缺主侧门。这与第四轮 X3「原始 URL 绕过 markdown 净化、要在交付出口 openExternal 收口」是同一形状的教训：**危险动作要在最后那道原生出口门控**——本轮 execute（spawn 出口）/ openPath（OS 关联出口）已照此在主侧加门（2026-06-30）。
3. **最小权限欠收敛**——通用 electronAPI 暴露但未用（IPC-003）、IPC 缝无运行时校验层（IPC-004）：都是「今日无洞、但边界不够窄 / 不够结构化」的加固项，**均已闭环**（IPC-003 删桥、IPC-004 补边界校验层）。

### 七之三 · 处置建议（优先级）

> **本轮与 2/3/4 轮处置不同**：因 IPC-001/002 的门控方案触及「本地优先 execute」的 UX 与架构（`dev-process`「AI 提案 → 人确认」），本轮**只交付发现 + 登记**，把方案选择交给人，不顺手改。以下为建议方向：

- **IPC-001（P2，首要）✅ 已修（2026-06-30）**：把 `execute` 门控**下沉主进程**——选 **(A) 执行前 native 确认对话框**（人决策 2026-06-30）并落地：`fs/execGate.ts` `confirmExecute` 在 `fs/ipc.ts` workspaceOp 句柄于 `op==='execute'` 时 spawn 前弹主侧确认，renderer 无法伪造；**每次必弹、不记忆**（与后端 `code_execute` PER_CALL/PI-004 同姿态——审批已在服务端做过一次，这是主侧最后一道，故云端合法本地执行会多弹一次、是有意取舍）；取消 → `opErr("ExecutionDenied")`。未采纳 (B) 默认关+开关（牺牲本地优先「开箱即跑」体验）/ (C) 能力票绑定（最贴合现架构但实现最重，native 门已足够且更直观）。
- **IPC-002（P3，与 001 同修）✅ 已修（2026-06-30）**：openPath 加可执行扩展名黑名单（`execGate.isExecutablePath`，黑名单姿态——人选「安全类型直开、仅可执行/脚本弹」），命中才与 IPC-001 同门弹主侧确认。**与 IPC-001 同一 commit 落地，未留「修 001 漏 002」的形同虚设缺口**。
- **IPC-003（P3，低成本）✅ 已修（2026-06-30）**：删除未用的通用 `electron` 暴露，收敛到 5 个有类型窄面（纯加固、零契约、preload lint 清）。
- **IPC-004（P3，结构加固）✅ 已修（2026-06-30）**：新增 `main/ipc-validate.ts` 薄运行时校验层（手写守卫、零新依赖、与契约类型同源），fs / sidecar / updater 各 IPC 句柄在边界先校验寻址类字段、按各自契约拒绝畸形入参，log `app:log` 本由下游 `sanitize()` 覆盖。边界校验从「下游偶然」升为「边界结构」（+9 单测，typecheck / vitest 全绿、零契约改动）。
- 各修复均按 `dev-process` 立项：001/002 先经人拍板门控方案再落地（属架构 / UX，**已闭环**）；003/004 为低风险加固、**已闭环**。**本轮 4/4 全数闭环**。

### 七之四 · 本轮边界回顾 & 后续

本轮仅**静态阅读 + 逻辑推演 + 关键链路核验**，未写 PoC。以下**故意未在本轮**（见 §一），建议作为后续：

- **动态 PoC**：在 renderer 注入一段 JS 调 `window.fsApi.workspaceOp(root,'execute',…)` / `write→openPath`，把「击穿后即 RCE」用真实样本钉死可利用性（本地验证，不真外泄）。
- sidecar JSON-RPC **协议健壮性**（撕裂帧 / 超大行 / 注入伪响应）——权限之外的另一根轴。
- mobile / admin 原生桥面（Capacitor 插件权限）——面小，与桌面分开。
- 第一轮排除的 **成本 / 性能 profiling**、**产品完整度矩阵**两个非安全专项仍待立轮。
