import { notifyInfo } from "@/lib/toast";

/**
 * One source of truth for what deleting a conversation is called and what it
 * promises, shared by every row that offers it (sidebar, 全部对话 list, 已归档 list,
 * 文件 hub rail).
 *
 * `DELETE /v1/conversations/{id}` has always been a soft delete, but four separate
 * call sites had each written their own confirm text and settled on「永久删除（无法
 * 恢复）」— a promise the backend never made and the「最近删除」bin now openly
 * contradicts. Keeping the wording here is what stops the next row from inventing a
 * fifth version of it.
 */

/** Menu item / icon label for deleting a conversation. */
export const DELETE_CONVERSATION_LABEL = "删除对话";

/**
 * The confirm-step label. `keptFiles` names the files this delete does *not* touch,
 * which differs by where the chat lives: a project chat leaves the shared folder
 * alone, a local scratch leaves the user's own disk alone.
 */
export function deleteConversationConfirmLabel(
  keptFiles?: "folder" | "local",
): string {
  const kept =
    keptFiles === "folder"
      ? "文件夹里的文件会保留，"
      : keptFiles === "local"
        ? "本地磁盘文件会保留，"
        : "";
  return `确认删除（${kept}可在「最近删除」里恢复）`;
}

/**
 * The post-delete toast. 撤销 is how most people come back from a mistaken delete —
 * they notice within seconds and never open「最近删除」— so every delete offers it,
 * and the row that raises this has usually unmounted by the time it is clicked (the
 * undo therefore belongs to a hook-level mutation, not a per-call callback).
 */
export function notifyConversationDeleted(
  title: string,
  onUndo: () => void,
): void {
  notifyInfo("已删除对话", {
    description: title,
    duration: 8000,
    action: { label: "撤销", onClick: onUndo },
  });
}
