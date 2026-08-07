import { Button } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getConversations } from "@/hooks/useConversations";
import { getFolders } from "@/hooks/useFolders";
import {
  WORKSPACE_BINDING_CHANGED,
  isLocalPickerFailureKind,
  notifyLocalPickerFailure,
  pickAndBindLocalFolder,
} from "@/lib/bindLocalFolder";
import { hasLocalFiles } from "@/lib/capabilities";
import { pickAndOpenLocalProject } from "@/lib/openLocalProject";
import { notifyError, notifySuccess } from "@/lib/toast";
import {
  type EffectiveWorkspace,
  formatWorkspaceChipLabel,
  resolveEffectiveWorkspace,
} from "@/lib/workspaceEffectiveMode";
import { runHandoff } from "@/services/handoff";
import {
  type WorkspaceBinding,
  getWorkspaceBinding,
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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";

/**
 * Shared workspace mode control — status for established chats (project inherit /
 * bare scratch). 出生定终身：不改当前会话 folder；云会话可发现入口 =
 * 打开本地项目（新会话）/ 裸聊绑定本机执行环境。Local workspaces keep backup.
 */

export interface WorkspaceModeState {
  binding: WorkspaceBinding;
  roots: FsRoot[];
  effective: EffectiveWorkspace;
  busy: boolean;
  error: string | null;
  backingUp: boolean;
  backupDone: boolean;
  backup: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useWorkspaceModeState(
  conversationId: string | null,
): WorkspaceModeState | null {
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [containerRootId, setContainerRootId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  // Track which conversation the in-memory binding belongs to. When the id
  // changes, clear synchronously during render so consumers never see the prior
  // session's effective.rootId (composer Git chip flash) before refresh resolves.
  const [boundConversationId, setBoundConversationId] = useState(conversationId);
  if (conversationId !== boundConversationId) {
    setBoundConversationId(conversationId);
    setBinding(null);
    setContainerRootId(null);
    setProjectName(null);
    setRoots([]);
    setError(null);
  }

  // Guard in-flight refresh: a slow getWorkspaceBinding for conv A must not
  // write back after the user has already switched to conv B.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;

  const loadRoots = useCallback(
    (): Promise<FsRoot[]> => fsApi?.listRoots() ?? Promise.resolve([]),
    [fsApi],
  );

  const refresh = useCallback(async () => {
    if (!conversationId) return;
    const forId = conversationId;
    const conv =
      getConversations().find((c) => c.id === forId) ?? null;
    setContainerRootId(conv?.localContainerRootId ?? null);
    const folder = conv?.folderId
      ? (getFolders().find((f) => f.id === conv.folderId) ?? null)
      : null;
    setProjectName(folder?.name ?? null);
    try {
      const [b, r] = await Promise.all([
        getWorkspaceBinding(forId),
        loadRoots(),
      ]);
      if (conversationIdRef.current !== forId) return;
      setBinding(b);
      setRoots(r);
    } catch {
      if (conversationIdRef.current !== forId) return;
      setBinding(null);
    }
  }, [conversationId, loadRoots]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!conversationId) return;
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ conversationId?: string }>).detail;
      if (detail?.conversationId === conversationId) void refresh();
    };
    window.addEventListener(WORKSPACE_BINDING_CHANGED, onChanged);
    return () =>
      window.removeEventListener(WORKSPACE_BINDING_CHANGED, onChanged);
  }, [conversationId, refresh]);

  const backup = async () => {
    if (!conversationId) return;
    setBackingUp(true);
    setError(null);
    setBackupDone(false);
    setBusy(true);
    try {
      await runHandoff(conversationId);
      setBackupDone(true);
      setTimeout(() => setBackupDone(false), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "备份失败，请重试");
    } finally {
      setBackingUp(false);
      setBusy(false);
    }
  };

  const effective = useMemo(
    () =>
      resolveEffectiveWorkspace({
        binding,
        localContainerRootId: containerRootId,
        roots,
        projectName,
      }),
    [binding, containerRootId, roots, projectName],
  );

  if (!conversationId || !binding) return null;

  return {
    binding,
    roots,
    effective,
    busy,
    error,
    backingUp,
    backupDone,
    backup,
    refresh,
  };
}

/** Compact trigger used by the dock bar and composer chip. */
export function WorkspaceModeTrigger({
  effective,
  className = "",
  chevron = true,
}: {
  effective: EffectiveWorkspace;
  className?: string;
  chevron?: boolean;
}) {
  const { isLocal, rootMissing } = effective;
  const label = formatWorkspaceChipLabel(effective);
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 overflow-hidden ${className}`}
    >
      {isLocal && rootMissing ? (
        <AlertTriangle size={13} className="shrink-0 text-muted-foreground" />
      ) : isLocal ? (
        <HardDrive size={13} className="shrink-0 text-primary" />
      ) : (
        <Cloud size={13} className="shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{label}</span>
      {chevron && (
        <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
      )}
    </span>
  );
}

/** Status + local backup, or cloud-session discoverable open/bind actions. */
export function WorkspaceModeMenu({
  state,
  conversationId,
  onActionDone,
}: {
  state: WorkspaceModeState;
  conversationId?: string;
  onActionDone?: () => void;
}) {
  const navigate = useNavigate();
  const { effective, busy, error, backingUp, backupDone, backup } = state;
  const { isLocal, rootMissing, rootName, viaProject, projectName } = effective;
  const desktop = hasLocalFiles();
  const [actionBusy, setActionBusy] = useState(false);

  const title = viaProject
    ? projectName
      ? `项目 · ${projectName}`
      : "项目工作区"
    : isLocal
      ? "本机草稿"
      : "云端草稿";

  const subtitle = isLocal
    ? rootMissing
      ? "目录在本机不可用"
      : rootName
        ? viaProject
          ? `本地 · ${rootName}`
          : `默认容器 · ${rootName}`
        : "本机草稿"
    : viaProject
      ? "云端共享空间"
      : "云端对话";

  const runOpenLocalProject = () => {
    setActionBusy(true);
    void pickAndOpenLocalProject(navigate, { notifyOnFailure: false })
      .then((result) => {
        if (result.ok) {
          onActionDone?.();
          return;
        }
        if (result.reason === "cancelled") return;
        if (isLocalPickerFailureKind(result.reason)) {
          notifyLocalPickerFailure(result.reason, result.message);
        }
      })
      .finally(() => setActionBusy(false));
  };

  const runBindLocal = () => {
    if (!conversationId) {
      notifyError("请先打开一个对话");
      return;
    }
    setActionBusy(true);
    void pickAndBindLocalFolder(conversationId)
      .then((result) => {
        if (!result.ok) {
          if (result.reason === "cancelled") return;
          if (isLocalPickerFailureKind(result.reason)) {
            notifyLocalPickerFailure(result.reason, result.message);
          }
          return;
        }
        notifySuccess(`已绑定「${result.root.name}」本机执行环境`, {
          description: "仅本会话；≠打开本地项目",
        });
        onActionDone?.();
      })
      .finally(() => setActionBusy(false));
  };

  return (
    <>
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
            {title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {subtitle}
          </div>
        </div>
      </div>

      <div className="p-1.5">
        {isLocal && !rootMissing ? (
          backingUp ? (
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
              disabled={busy || actionBusy}
            />
          )
        ) : isLocal && rootMissing ? (
          <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
            目录在本机不可用。可打开本地项目换到可用文件夹（新会话）。
          </p>
        ) : desktop ? (
          <>
            <ModeAction
              icon={<FolderOpen size={14} />}
              label="打开本地项目"
              hint="选本机文件夹 · 新会话"
              onClick={runOpenLocalProject}
              disabled={busy || actionBusy}
            />
            {!viaProject && conversationId ? (
              <ModeAction
                icon={<HardDrive size={14} />}
                label="绑定本机执行环境"
                hint="仅本会话；≠打开项目"
                onClick={runBindLocal}
                disabled={busy || actionBusy}
              />
            ) : null}
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
              本会话工作区仍是云端；要在本机落盘请用上面入口（不改当前会话绑定）。
            </p>
          </>
        ) : (
          <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
            工作区在创建时已确定，会话期间不可改绑。
          </p>
        )}

        {(busy || actionBusy) && !backingUp && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            处理中…
          </div>
        )}
        {error && (
          <p className="px-2.5 py-1.5 text-xs text-destructive">{error}</p>
        )}
      </div>
    </>
  );
}

function ModeAction({
  icon,
  label,
  hint,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
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
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint ? (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
    </Button>
  );
}

/** Full control: trigger + shared popover (dock mode bar). */
export function WorkspaceModeControl({
  conversationId,
  triggerClassName,
}: {
  conversationId: string;
  triggerClassName?: string;
}) {
  const state = useWorkspaceModeState(conversationId);
  const [pop, setPop] = useState(false);

  if (!state) return null;

  return (
    <Popover open={pop} onOpenChange={setPop}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className={
            triggerClassName ??
            `h-auto min-w-0 shrink gap-1.5 overflow-hidden px-2 py-1 text-xs font-medium ${
              state.effective.isLocal && state.effective.rootMissing
                ? "text-muted-foreground"
                : "text-foreground"
            }`
          }
        >
          <WorkspaceModeTrigger effective={state.effective} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <WorkspaceModeMenu
          state={state}
          conversationId={conversationId}
          onActionDone={() => setPop(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
