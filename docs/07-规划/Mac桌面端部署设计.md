# Mac 桌面端部署设计（内测 · Apple Silicon）🗂️

> **定位**：在 Windows 内测发布已跑通的前提下，把 **macOS arm64** 纳入同一 `desktop-v*` 发布列车——内测档位、未签名、Win/Mac 同 tag 同步出包。
>
> **状态**：🗂️ 提案，**P0 + P1 已落地**；**0.3.0 已发布**（`Lawofall/AgentCore-releases` v0.3.0，Win + Mac arm64）。正式签名 + 公证归 P2。

---

## 〇、决策摘要

| 维度 | 决定 |
|---|---|
| 分发档位 | **内测**——不做 Developer ID 签名 / notarize；接受 Gatekeeper 首次打开警告 |
| 架构 | **arm64 only**（Apple Silicon）；不做 Universal；Intel Mac 不在支持范围 |
| 发布节奏 | **与 Windows 同 tag 同步**——`desktop-v<x.y.z>` → 公开发布仓 `v<x.y.z>` draft 同时含 Win + Mac 资产 |
| 首装载体 | **DMG**（`AgentCore-<ver>-mac-arm64.dmg`） |
| 自动更新载体 | **zip** + `latest-mac.yml`（与 Windows `latest.yml` 并列；内测下 `quitAndInstall` 可能再次遇 Gatekeeper） |
| sidecar | 各平台 runner **本机构建** `pnpm bundle:sidecar`（不可交叉编译） |

---

## 一、产物清单（单版本 draft release）

打 `desktop-v0.3.0` 后，`Lawofall/AgentCore-releases` 的 `v0.3.0` draft 应含：

| 平台 | 文件 | 用途 |
|---|---|---|
| Windows | `AgentCore-<ver>-win-x64.exe` + `.blockmap` + `latest.yml` | 安装 + 自动更新 |
| macOS | `AgentCore-<ver>-mac-arm64.dmg` | 内测首装 |
| macOS | `AgentCore-<ver>-mac-arm64.zip` + `.blockmap` + `latest-mac.yml` | 自动更新 |

**转正前检查**：Win exe 与 Mac dmg/zip 均在同一 draft 下；缺一平台则不要 publish。

---

## 二、CI 结构

```
desktop-v* tag
    │
    ▼
precreate-release (ubuntu-latest)
    ├─ 校验 tag == package.json version
    └─ gh release create v<ver> --draft（幂等复用）
    │
    ├──────────────────┬──────────────────┐
    ▼                  ▼                  │
release matrix    release matrix           │
windows-latest    macos-latest             │
--win             --mac --arm64            │
bundle:sidecar    bundle:sidecar           │
build + publish   build + publish          │
```

实现：→ [`.github/workflows/release-desktop.yml`](/.github/workflows/release-desktop.yml)

`fail-fast: false`：一平台失败不立刻取消另一平台，但 workflow 仍红；**不要 publish 残缺 release**。

---

## 三、内测安装指引（测试者）

```markdown
## macOS（Apple Silicon only）

1. 从 draft release 下载 `AgentCore-x.y.z-mac-arm64.dmg`
2. 拖入「应用程序」
3. 首次打开：右键 AgentCore →「打开」→ 确认
   （或终端：`xattr -cr /Applications/AgentCore.app`）
4. Intel Mac 不在支持范围
```

自动更新（可选验证）：关于页应能发现新版本；未签名环境下「重启安装」后可能需再次右键打开。

---

## 四、真机 QA（Go/No-Go）

在 **真实 Apple Silicon Mac** 上验收（Rosetta 不算）：

| # | 路径 | 通过标准 |
|---|---|---|
| 1 | DMG 安装 | 拖入 Applications 后能启动（经右键打开） |
| 2 | 登录 / 云对话 | SSE 流式、消息正常 |
| 3 | 绑定本地文件夹 | sidecar 启动（内置 Python，无系统 Python） |
| 4 | 本地回合 | 文件读写 / 审批门可走通 |
| 5 | 自动更新 | 降版本后关于页能发现新版本；下载正常（安装允许 Gatekeeper workaround） |
| 6 | 同版本双平台 | 同一 `desktop-v*` draft 含 Win exe + Mac dmg/zip |

CI 内 `bundle:sidecar` 末尾 `import agentcore.sidecar.server` 冒烟必须通过；本地文件夹 E2E 仅真机可验。

---

## 五、刻意不做（分期）

| 项 | 阶段 | 说明 |
|---|---|---|
| 代码签名 / notarize | P2 正式 | 需 Apple Developer + entitlements + CI secrets |
| Universal (x64+arm64) | — | 已否决 |
| TitleBar Mac 化（隐藏自定义 `-□×`、交通灯留白） | P1 体验 | ✅ `WindowControls` + `macTitleBarInsetClass`；全屏页 `ProductManual` 同步 |
| 原生菜单栏 / Dock badge | P1+ | §7.4 OS 深度集成 |
| Linux AppImage CI | — | 不在本次范围 |

---

## 六、P2 正式分发（预留）

正式 GA 时在 `electron-builder.yml` `mac` 段补：`identity`、`hardenedRuntime`、`entitlements` / `entitlementsInherit`、`notarize`；CI 增加 Apple 证书 / API Key secrets。与 Windows 代码签名一并规划 → [`前端技术与架构.md` §十三](/docs/04-前端/前端技术与架构.md)。

---

## 七、相关代码指针

|  Concern | 位置 |
|---|---|
| 打包配置 | [`apps/desktop/electron-builder.yml`](/apps/desktop/electron-builder.yml) |
| 本地构建 | `pnpm build:mac` → [`apps/desktop/package.json`](/apps/desktop/package.json) |
| sidecar 捆绑 | [`apps/desktop/scripts/bundle-sidecar.mjs`](/apps/desktop/scripts/bundle-sidecar.mjs) |
| 主进程 Mac 窗口 | [`apps/desktop/src/main/index.ts`](/apps/desktop/src/main/index.ts)（`titleBarStyle: hidden`、交通灯、`activate`） |
| 自动更新 | [`apps/desktop/src/main/updater.ts`](/apps/desktop/src/main/updater.ts) |
| 双仓发布总述 | [`部署与运维.md` §7.6](/docs/05-平台与运维/部署与运维.md) |

---

## 八、发布 checklist

### 8.A 单独补发 Mac 0.2.0（本次）

> Win 0.2.0 已发过 → **不要重打 `desktop-v0.2.0` tag**（会重建 Win）。只补 Mac 资产到同一 `v0.2.0`。

**方式一：GitHub Actions（推荐）**

1. 确认 `apps/desktop/package.json` version = **0.2.0**
2. 源码仓 → Actions → **Release Desktop** → Run workflow
3. Branch：当前含 Mac CI 的 `master`（或你的主干）
4. Platform：**mac**
5. 等 `macOS arm64` job 绿
6. 打开发布仓 `v0.2.0`，确认新增：
   - `AgentCore-0.2.0-mac-arm64.dmg`
   - `AgentCore-0.2.0-mac-arm64.zip` + `.blockmap`
   - `latest-mac.yml`
7. 若 `v0.2.0` 仍是 **draft** → 核对 Win+Mac 齐全后 Publish；若 **已 published** → Mac 资产上传完即可，内测发 dmg 链接

**方式二：本机 Apple Silicon 手构上传**（无 CI / release 已 published 且 electron-builder 上传失败时）

```bash
cd apps/desktop
pnpm install   # 根目录；需 PATH 上有 uv
pnpm build:mac
# 产物在 release/0.2.0/
gh release upload v0.2.0 \
  release/0.2.0/AgentCore-0.2.0-mac-arm64.dmg \
  release/0.2.0/AgentCore-0.2.0-mac-arm64.zip \
  release/0.2.0/AgentCore-0.2.0-mac-arm64.zip.blockmap \
  release/0.2.0/latest-mac.yml \
  --repo Lawofall/AgentCore-releases
```

内测通知附 §三 安装指引（右键打开）。

---

### 8.B 下次起 Win + Mac 一起发（常规）

- [ ] bump `package.json` version（如 0.2.0 → 0.2.1）
- [ ] `git tag desktop-v0.2.1 && git push origin desktop-v0.2.1`
- [ ] CI 两个 matrix job 均绿
- [ ] draft 含 §一 全部 7 个资产 → QA → Publish

Release notes 模板（一起发时用）：

```markdown
## AgentCore 0.2.x

### 新增
- macOS（Apple Silicon）内测安装包

### 平台说明
- macOS：仅 arm64；未签名，首次 **右键 → 打开**
- Windows：NSIS 安装包
```

### 8.C 失败回滚

| 情况 | 处理 |
|---|---|
| Mac job 红 | 修 CI/sidecar → workflow_dispatch 重跑 `mac` |
| 误重打 `desktop-v0.2.0` tag | Win 被重建；无害但浪费；以后单平台用 dispatch |
| 已 publish 坏 Mac 包 | 删发布仓错误资产或发 hotfix 版本 |
