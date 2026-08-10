/**
 * 工作区文件下载失败文案 —— 把 HTTP 状态翻成用户可行动的说明
 *（本机权威 / 云端缺文件），避免笼统「下载文件失败 (404)」。
 */

/** Map download HTTP status to a short Chinese message. */
export function workspaceFileDownloadError(
  status: number,
  opts?: { scope?: "conversation" | "workspace" },
): string {
  const scope = opts?.scope ?? "conversation";
  if (status === 404) {
    return scope === "workspace"
      ? "云端工作区没有这个文件（可能未同步、已删除，或写在别的项目桌）。"
      : "云端工作区没有这个文件（可能只在电脑本机、未同步，或路径不对）。";
  }
  if (status === 409) {
    return "本机工作区文件仅桌面端可打开。";
  }
  if (status === 401 || status === 403) {
    return "没有权限打开这个文件。";
  }
  return `下载文件失败 (${status})`;
}

/** Deep-link openPath 在树中不存在时的说明。 */
export const FILE_NOT_IN_CLOUD_TREE =
  "云端工作区暂无此文件。若在电脑本机产出，请在桌面端打开；云协作会话请确认已写入当前工作区。";

/** 本机传统会话文件页空态 / 横幅。 */
export const LOCAL_WORKSPACE_MOBILE_HINT =
  "此对话绑定的是本机文件夹，文件在电脑本地。手机只能浏览云端工作区——请在桌面端打开，或改用云协作项目。";
