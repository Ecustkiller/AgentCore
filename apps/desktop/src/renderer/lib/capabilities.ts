/**
 * 运行时能力描述符（cross-platform-frontend §7：web/手机 = 桌面 − 物理做不到的能力层）。
 *
 * 桌面渲染层跑在两种运行时：Electron 外壳（完整原生能力）与纯浏览器（生产 web 客户端
 * `main.webapp.tsx`、离线预览 `main.web.tsx`）。两个浏览器入口都给那四个 preload 全局装了
 * 无害桩并置 `window.__WEB__`，所以「全局是否存在」不再是「我是不是桌面」的真信号。一律经
 * 这些帮手读能力，别再直接嗅探 `window.fsApi` / `window.sidecarApi` 判端。
 */

/** 当前是否跑在浏览器 web 运行时（生产 web 客户端或离线预览），而非 Electron 外壳。 */
export function isWebRuntime(): boolean {
  return typeof window !== "undefined" && window.__WEB__ === true;
}

/** 本地文件工作区（授权根、读写磁盘、@ 提及本地文件）——仅桌面，web 降级关闭。 */
export function hasLocalFiles(): boolean {
  return typeof window !== "undefined" && !!window.fsApi && !isWebRuntime();
}

/** 本地引擎（sidecar，在用户机器上跑回合）——仅桌面，web 恒走云端 SSE。 */
export function hasLocalEngine(): boolean {
  return (
    typeof window !== "undefined" && !!window.sidecarApi && !isWebRuntime()
  );
}

/** 自绘无边框窗口控件（最小化 / 最大化 / 关闭）——仅桌面外壳；web 用浏览器自带窗口
 *  chrome（macOS 桌面用原生交通灯，由组件内 isMac 再分流）。 */
export function hasWindowControls(): boolean {
  return !isWebRuntime();
}

/** 应用内自动更新（主进程 electron-updater）——仅桌面外壳；web 客户端随刷新拿到新版。 */
export function hasAutoUpdater(): boolean {
  return !isWebRuntime();
}
