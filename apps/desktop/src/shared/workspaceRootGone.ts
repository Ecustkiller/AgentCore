/**
 * 本机授权根还在表里，空子路径指向的文件夹已不在盘上（改名 / 移动 / 删除）。
 * 主进程抛给 IPC、渲染层横幅共用同一句，避免 JSON-RPC 英文截断。
 */
export function workspaceRootGoneMessage(absPath?: string): string {
  const path = absPath?.trim();
  if (path) {
    return `这个文件夹已经不在这台电脑上：${path}。请在工作区芯片里重新选择它所在的位置。`;
  }
  return "这个文件夹已经不在这台电脑上。请在工作区芯片里重新选择它所在的位置。";
}
