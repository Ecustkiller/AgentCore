/**
 * 已退役：本机传统 Ask / 入口改导 toast。
 * 双通道观察期恢复后，open/register/bind 走真实 picker；本模块保留符号以免并行桶
 * 外调用方瞬时断 import，行为均为 no-op。
 */

/** @deprecated 本机传统已恢复履约；恒为 false。 */
export function isRedirectedLocalWorkspaceAskAction(
  _action: string | undefined,
): boolean {
  return false;
}

/** @deprecated 不再 toast 改导；调用方可删。 */
export function redirectLocalWorkspaceAskAction(): void {
  // no-op
}
