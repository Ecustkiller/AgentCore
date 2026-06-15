import { ApiError } from "@/services/api";
import { runHandoff } from "@/services/handoff";
import {
  type WorkspaceBinding,
  bindLocalWorkspace,
  getWorkspaceBinding,
  isBoundRootMissing,
  unbindWorkspace,
} from "@/services/workspaceBinding";
import { useConversationStore } from "@/stores/conversation";
import { useFilesStore } from "@/stores/files";
import { useFoldersStore } from "@/stores/folders";
import type { FsRoot } from "@shared/ipc-contract";
import {
  AlertTriangle,
  Check,
  Cloud,
  FolderOpen,
  HardDrive,
  Loader2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Workspace mode control for the open conversation (双模式工作区 §七/§八). Shows
 * whether the chat runs in the cloud or on a bound local folder, and is the
 * "打开本地文件夹" entry: it reuses the same OS picker as the Files page
 * (`fsApi.addRoot`) and then binds the folder server-side (`PUT …/binding`), so
 * the team's tools read/write the user's machine. When the bound root is gone on
 * this device it surfaces the §八 degradation with reconnect / switch-to-cloud.
 *
 * Mounted only for a real conversation (the panel renders an empty hint for a
 * draft), so `conversationId` is always a persisted id here.
 */
export function WorkspaceModeBar({
  conversationId,
}: {
  conversationId: string;
}) {
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  // Local→云 handoff (P2e / e1): a separate state from `busy` so the bar keeps
  // showing the workspace context while the (potentially slow) archive runs.
  const [backingUp, setBackingUp] = useState(false);
  const [backupDone, setBackupDone] = useState(false);

  // Desktop-only: a web build has no fsApi, so local mode can't be entered there.
  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;

  const loadRoots = useCallback(
    (): Promise<FsRoot[]> => fsApi?.listRoots() ?? Promise.resolve([]),
    [fsApi],
  );

  const refresh = useCallback(async () => {
    setConfirmDisconnect(false);
    try {
      const [b, r] = await Promise.all([
        getWorkspaceBinding(conversationId),
        loadRoots(),
      ]);
      setBinding(b);
      setRoots(r);
    } catch {
      // Best-effort status read; leave the bar blank rather than block the panel.
      setBinding(null);
    }
  }, [conversationId, loadRoots]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Mirror a bind/unbind onto the sidebar so its mode badge updates without a
  // reload. The server owns the scope: a foldered chat writes the folder (every
  // sibling flips), an ungrouped one writes itself.
  const syncStores = (b: WorkspaceBinding) => {
    if (b.scope === "folder") {
      const folderId = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversationId)?.folderId;
      if (folderId)
        useFoldersStore
          .getState()
          .updateFolderMeta(folderId, { localRootId: b.rootId });
    } else {
      useConversationStore
        .getState()
        .setConversationLocalRoot(conversationId, b.rootId);
    }
  };

  const describeError = (e: unknown): string =>
    e instanceof ApiError && e.status === 404
      ? "对话不存在或无权访问"
      : "操作失败，请重试";

  // Open the OS folder picker, then bind it (cloud → local). Also used to
  // "reconnect" a missing root: re-picking and re-binding repairs the §八 break.
  const openFolder = async () => {
    if (!fsApi) return;
    setBusy(true);
    setError(null);
    try {
      const root = await fsApi.addRoot();
      if (!root) return; // user cancelled the picker
      const b = await bindLocalWorkspace(conversationId, root.id);
      useFilesStore.getState().addRoot(root); // surface it on the Files page too
      setBinding(b);
      setRoots(await loadRoots());
      syncStores(b);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    setConfirmDisconnect(false);
    try {
      const b = await unbindWorkspace(conversationId);
      setBinding(b);
      syncStores(b);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  // Snapshot the bound local workspace up to the cloud (双模式工作区 P2e / e1):
  // backup + cross-device. The desktop packs the root over the channel and the
  // server snapshots it into the same list as cloud-mode versions. Best-effort
  // and off the chat path; surfaces a brief "已备份" then clears.
  const backup = async () => {
    setBackingUp(true);
    setError(null);
    setBackupDone(false);
    try {
      await runHandoff(conversationId);
      setBackupDone(true);
      setTimeout(() => setBackupDone(false), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "备份失败，请重试");
    } finally {
      setBackingUp(false);
    }
  };

  // Folder-scoped unbinds flip every sibling chat, so they take a confirm tap;
  // a conversation-scoped one only affects this chat and unbinds directly.
  const onDisconnectClick = () => {
    if (binding?.scope === "folder" && !confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    void disconnect();
  };

  if (!binding) return null; // status not loaded yet (or read failed) — stay quiet

  const isLocal = binding.mode === "local";
  const rootMissing = isBoundRootMissing(binding, roots);
  const rootName = isLocal
    ? (roots.find((r) => r.id === binding.rootId)?.name ?? null)
    : null;

  return (
    <div className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-md ${
            isLocal
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {isLocal ? <HardDrive size={14} /> : <Cloud size={14} />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">
            {isLocal ? "本地工作区" : "云端工作区"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {isLocal
              ? rootMissing
                ? "目录在本机不可用"
                : `${rootName ?? "已绑定目录"}${
                    binding.scope === "folder" ? " · 文件夹共享" : ""
                  }`
              : "文件存放在团队云端"}
          </div>
        </div>

        {busy ? (
          <Loader2
            size={15}
            className="shrink-0 animate-spin text-muted-foreground"
          />
        ) : isLocal ? (
          confirmDisconnect ? (
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/10"
              >
                确认切回云端
              </button>
              <button
                type="button"
                onClick={() => setConfirmDisconnect(false)}
                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
              >
                取消
              </button>
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              {!rootMissing &&
                (backingUp ? (
                  <span className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground">
                    <Loader2 size={13} className="animate-spin" />
                    备份中…
                  </span>
                ) : backupDone ? (
                  <span className="flex items-center gap-1 px-2 py-1 text-[11px] text-success">
                    <Check size={13} />
                    已备份
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void backup()}
                    title="把本地工作区快照备份到云端（可在快照列表恢复 / 下载）"
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <UploadCloud size={13} />
                    备份到云
                  </button>
                ))}
              <button
                type="button"
                onClick={onDisconnectClick}
                disabled={backingUp}
                title={
                  binding.scope === "folder"
                    ? "该文件夹下所有对话都会切回云端"
                    : "切回云端工作区"
                }
                className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                断开
              </button>
            </span>
          )
        ) : (
          fsApi && (
            <button
              type="button"
              onClick={() => void openFolder()}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent/70"
            >
              <FolderOpen size={13} />
              打开本地文件夹
            </button>
          )
        )}
      </div>

      {/* §八 degradation: the bound root isn't on this device (removed, or bound
          on another machine — local projects don't follow you across devices). */}
      {isLocal && rootMissing && !busy && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-[11px] text-warning-foreground">
          <AlertTriangle size={14} className="mt-px shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-foreground/80">
              这个项目的本地目录在本机找不到了。重新选择该文件夹即可继续，或切回云端工作区。
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              {fsApi && (
                <button
                  type="button"
                  onClick={() => void openFolder()}
                  className="rounded-md bg-accent px-2 py-1 font-medium text-foreground hover:bg-accent/70"
                >
                  重新连接…
                </button>
              )}
              <button
                type="button"
                onClick={() => void disconnect()}
                className="rounded-md px-2 py-1 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                切回云端
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
