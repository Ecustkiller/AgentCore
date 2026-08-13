// Internal drag payload (source-relative paths + their source id). A custom MIME
// distinguishes it from an OS file drag (which carries `Files` → "upload"); the
// source id tells the drop side whether this is a move within the source or a
// cross-source transfer.
export const DRAG_MIME = "application/x-agentcore-file";

export interface DragPayload {
  sourceId: string;
  /**
   * 被拖走的顶层项（至少一项）。拖的是选区里的行时 = 整个选区（已剔掉「祖先也在选区里」
   * 的后代），所以一次拖拽可以搬 N 项；拖选区外的行时只有那一行。
   */
  paths: string[];
}

export function parseDragPayload(raw: string): DragPayload | null {
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== "object") return null;
    const { sourceId, paths } = p as Partial<DragPayload>;
    if (typeof sourceId !== "string") return null;
    if (!Array.isArray(paths) || paths.length === 0) return null;
    if (!paths.every((path) => typeof path === "string")) return null;
    return { sourceId, paths };
  } catch {
    /* not our payload */
  }
  return null;
}
