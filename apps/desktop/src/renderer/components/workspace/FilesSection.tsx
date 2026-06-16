import { createWorkspaceSource } from "@/services/sources/workspaceSource";
import { useMemo } from "react";
import { FileBrowser } from "./FileBrowser";

/**
 * 对话工作区的文件面板 = 共用 {@link FileBrowser} 的 n=1 实例（文件夹即工作区）：
 * 本文件只负责「按对话选源」（per-conversation 别名 `createWorkspaceSource`），
 * 树构建 / 增删改 / 拖拽 / 上传 / 预览全部下沉到 FileBrowser，与文件夹总览页共用。
 */
export function FilesSection({ conversationId }: { conversationId: string }) {
  const source = useMemo(
    () => createWorkspaceSource(conversationId),
    [conversationId],
  );
  return <FileBrowser source={source} />;
}
