/** How to surface server-resolved worker desks on the kickoff card. */
export type WorkspacePresentation =
  | { mode: "none" }
  | { mode: "summary"; name: string }
  | { mode: "perWorker" };

type DeskRow = {
  target_folder_id?: string;
  target_folder_name?: string;
};

/**
 * 全员同桌 → 一行汇总；不一致 → 逐人；旧帧无显示名 → 不展示。
 * 不做空值猜语义：只吃服务端 `target_folder_name`。
 */
export function resolveWorkspacePresentation(
  workers: readonly DeskRow[],
): WorkspacePresentation {
  if (workers.length === 0) return { mode: "none" };

  const names = workers.map((w) => {
    const n =
      typeof w.target_folder_name === "string"
        ? w.target_folder_name.trim()
        : "";
    return n || null;
  });

  if (names.every((n) => n === null)) return { mode: "none" };
  // Partial old/new mix or any blank name → per-row (only rows with a name paint).
  if (names.some((n) => n === null)) return { mode: "perWorker" };

  const keys = workers.map((w) => {
    const id =
      typeof w.target_folder_id === "string" ? w.target_folder_id.trim() : "";
    if (id) return `id:${id}`;
    return `name:${(w.target_folder_name ?? "").trim()}`;
  });
  const sharedName = names.find((n): n is string => n != null);
  if (sharedName && keys.every((k) => k === keys[0])) {
    return { mode: "summary", name: sharedName };
  }
  return { mode: "perWorker" };
}

export function formatWorkspaceLabel(name: string): string {
  return `工作区 · ${name}`;
}
