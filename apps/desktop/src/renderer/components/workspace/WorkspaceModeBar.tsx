import { Button } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getConversations } from "@/hooks/useConversations";
import { patchFolderCache } from "@/hooks/useFolders";
import { hasLocalFiles } from "@/lib/capabilities";
import { ApiError } from "@/services/api";
import { runHandoff } from "@/services/handoff";
import {
  type WorkspaceBinding,
  bindLocalWorkspace,
  getWorkspaceBinding,
  isBoundRootMissing,
  unbindWorkspace,
} from "@/services/workspaceBinding";
import type { FsRoot } from "@shared/ipc-contract";
import {
  AlertTriangle,
  Check,
  ChevronDown,
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
  // Popover open state — controlled so a completed bind / unbind can close it.
  const [pop, setPop] = useState(false);

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
  // reload. 文件夹即工作区: a binding lives on the folder (every sibling flips), so we
  // patch the folder cache. A 裸聊 bind promotes the chat into a folder server-side;
  // its new membership lands on the next conversations refetch, so nothing to patch
  // here (the folderId isn't in cache yet).
  const syncStores = (b: WorkspaceBinding) => {
    if (b.scope === "folder") {
      const folderId = getConversations().find(
        (c) => c.id === conversationId,
      )?.folderId;
      if (folderId) patchFolderCache(folderId, { localRootId: b.rootId });
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
      setBinding(b);
      setRoots(await loadRoots());
      syncStores(b);
      setPop(false);
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
      setPop(false);
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
    <Popover
      open={pop}
      onOpenChange={(o) => {
        setPop(o);
        if (!o) setConfirmDisconnect(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={`h-auto min-w-0 shrink gap-1.5 overflow-hidden px-2 py-1 text-xs font-medium ${
            isLocal && rootMissing ? "text-muted-foreground" : "text-foreground"
          }`}
        >
          {isLocal && rootMissing ? (
            <AlertTriangle
              size={13}
              className="shrink-0 text-muted-foreground"
            />
          ) : isLocal ? (
            <HardDrive size={13} className="shrink-0 text-primary" />
          ) : (
            <Cloud size={13} className="shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 max-w-[120px] truncate">
            {isLocal ? (rootName ?? "本地") : "云端"}
          </span>
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-64 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <span
            className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
              isLocal
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {isLocal ? <HardDrive size={15} /> : <Cloud size={15} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">
              {isLocal ? "本地工作区" : "云端工作区"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {isLocal
                ? rootMissing
                  ? "目录在本机不可用"
                  : `${rootName ?? "已绑定目录"}${
                      binding.scope === "folder" ? " · 文件夹共享" : ""
                    }`
                : "文件存放在团队云端"}
            </div>
          </div>
        </div>

        <div className="p-1.5">
          {isLocal ? (
            rootMissing ? (
              <>
                {/* §八 degradation: the bound root isn't on this device (removed,
                    or bound on another machine — local projects don't follow you
                    across devices). */}
                <div className="mb-1 flex items-start gap-2 rounded-lg bg-muted px-2.5 py-2 text-xs text-foreground">
                  <AlertTriangle
                    size={14}
                    className="mt-px shrink-0 text-muted-foreground"
                  />
                  <p className="text-foreground/80">
                    这个项目的本地目录在本机找不到了。重新选择该文件夹即可继续，或切回云端工作区。
                  </p>
                </div>
                {hasLocalFiles() && (
                  <ModeAction
                    icon={<FolderOpen size={14} />}
                    label="重新连接…"
                    onClick={() => void openFolder()}
                    disabled={busy}
                  />
                )}
                <ModeAction
                  icon={<Cloud size={14} />}
                  label="切回云端"
                  onClick={() => void disconnect()}
                  disabled={busy}
                />
              </>
            ) : (
              <>
                {backingUp ? (
                  <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" />
                    备份中…
                  </div>
                ) : backupDone ? (
                  <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-success">
                    <Check size={14} />
                    已备份
                  </div>
                ) : (
                  <ModeAction
                    icon={<UploadCloud size={14} />}
                    label="备份到云"
                    onClick={() => void backup()}
                    disabled={busy}
                  />
                )}
                {confirmDisconnect ? (
                  <div className="px-1.5 pt-1">
                    <p className="pb-1 text-xs text-muted-foreground">
                      {binding.scope === "folder"
                        ? "该文件夹下所有对话都会切回云端"
                        : "切回云端工作区"}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="danger"
                        className="flex-1"
                        onClick={() => void disconnect()}
                      >
                        确认切回云端
                      </Button>
                      <Button
                        variant="neutral"
                        onClick={() => setConfirmDisconnect(false)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <ModeAction
                    icon={<Cloud size={14} />}
                    label="切回云端"
                    onClick={onDisconnectClick}
                    disabled={busy || backingUp}
                  />
                )}
              </>
            )
          ) : hasLocalFiles() ? (
            <ModeAction
              icon={<FolderOpen size={14} />}
              label="打开本地文件夹"
              onClick={() => void openFolder()}
              disabled={busy}
            />
          ) : (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
              桌面端可绑定本地文件夹
            </p>
          )}

          {busy && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              处理中…
            </div>
          )}
          {error && (
            <p className="px-2.5 py-1.5 text-xs text-destructive">{error}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A full-width action row inside the mode popover. */
function ModeAction({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="h-auto w-full justify-start gap-2 px-2.5 py-1.5 text-left text-xs font-medium"
      icon={<span className="shrink-0 text-muted-foreground">{icon}</span>}
    >
      {label}
    </Button>
  );
}
