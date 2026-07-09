/**
 * 聊天代码块「在终端运行」IPC 契约 —— 主进程 / preload / renderer 三端共享。
 *
 * 仅桌面 Electron 外壳暴露；浏览器预览不注入。主进程在 spawn 前弹 native 确认，
 * renderer 无法绕过。
 */

export const TERMINAL_CHANNELS = {
  runBash: "terminal:runBash",
  openShellAtRoot: "terminal:openShellAtRoot",
} as const;

export type TerminalRunResult =
  | { ok: true }
  | { ok: false; reason: string };

/** 暴露在 `window.terminalApi` 上的 renderer 端 API 面。 */
export interface TerminalApi {
  /** 在用户 shell 的新终端窗口中运行 bash 命令（主进程确认后 spawn）。 */
  runBash: (command: string) => Promise<TerminalRunResult>;
  /**
   * 在授权本地工作区目录打开交互式终端（无命令确认门；仅 cd 到工作区根）。
   * `subpath` 为容器根下的工作区子路径（对话级 scratch 对称化）。
   */
  openShellAtRoot: (
    rootId: string,
    subpath?: string,
  ) => Promise<TerminalRunResult>;
}
