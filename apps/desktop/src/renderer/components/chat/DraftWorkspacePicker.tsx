import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGroupedConversations } from "@/hooks/useConversations";
import { getFolders, useCreateFolder } from "@/hooks/useFolders";
import { ensureDefaultContainerRoot } from "@/services/defaultWorkspace";
import { useFoldersStore } from "@/stores/folders";
import {
  Check,
  ChevronDown,
  Cloud,
  FolderOpen,
  HardDrive,
  Loader2,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

const isDesktop = typeof window !== "undefined" && !!window.fsApi;

/**
 * 草稿期「对话工作区」选择器（双模式工作区 §六 / 前端UX §九「对话落点表达」）。
 *
 * 只在新对话草稿（尚未落库、`MessageInput` 里 `conversationId == null`）的输入框工具行
 * 出现，把「这条对话落到哪个文件夹=工作区」从隐藏路径（/conversations 先筛文件夹、/files
 * 加文件夹）提升为一等入口控件。选的是**落点文件夹**而非「云/本地」——模式仍由该文件夹的
 * 绑定派生（守「无云/本地开关」）。默认「自动」= 现状的桌面 local-first 懒建，零门槛不变。
 *
 * 落点经草稿态 `pendingNewChat*` 字段传给 `MessageInput.handleSend`（首发建会话时消费成
 * `folder_id` / `local_container_root_id` / 云端意向），故本控件不碰发送链路与后端契约。
 * 「打开本地文件夹」复用 F2（`POST /v1/folders { local_root_id }`）：先弹 OS 选择器拿到桌面
 * 根，再按 `localRootId` 复用已有本地项目、否则建一个，最后预填为落点文件夹。
 *
 * 首发后归属锁定（§七），故本控件**仅草稿期**渲染；已落库对话改由会话内 `WorkspaceModeBar`
 * 承担云/本地切换。web / 手机无 `fsApi`：退化为「自动（云）+ 已有云项目」。
 */
export function DraftWorkspacePicker() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = useGroupedConversations().data;
  const folders = useMemo(() => grouped?.folders ?? [], [grouped]);
  const conversations = useMemo(() => grouped?.conversations ?? [], [grouped]);

  const pendingFolderId = useFoldersStore((s) => s.pendingNewChatFolderId);
  const pendingCloud = useFoldersStore((s) => s.pendingNewChatCloud);
  const setFolder = useFoldersStore((s) => s.setPendingNewChatFolder);
  const setCloud = useFoldersStore((s) => s.setPendingNewChatCloud);

  const createFolderMut = useCreateFolder();

  // 「最近项目」：按各文件夹下对话的最新活跃时间降序取前 6。web 只列云项目
  // （本地绑定项目在 web 无法运行）。
  const recent = useMemo(() => {
    const lastActivity = new Map<string, number>();
    for (const c of conversations) {
      if (!c.folderId) continue;
      const t = Date.parse(c.updatedAt) || 0;
      lastActivity.set(
        c.folderId,
        Math.max(lastActivity.get(c.folderId) ?? 0, t),
      );
    }
    return [...folders]
      .filter((f) => isDesktop || f.localRootId == null)
      .sort(
        (a, b) => (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
      )
      .slice(0, 6);
  }, [folders, conversations]);

  const selectedFolder = pendingFolderId
    ? (folders.find((f) => f.id === pendingFolderId) ?? null)
    : null;

  const pickFolder = (id: string) => {
    setFolder(id);
    setCloud(false);
    setOpen(false);
  };

  const pickAuto = () => {
    setFolder(null);
    setCloud(false);
    // 预热默认容器根，摊薄首发时的授权等待（与 newConversation 同款预热）。
    if (isDesktop) void ensureDefaultContainerRoot();
    setOpen(false);
  };

  const pickCloud = () => {
    setFolder(null);
    setCloud(true);
    setOpen(false);
  };

  // 「打开本地文件夹」= F2：选目录 → 按 root 复用/新建本地项目 → 预填为落点。
  const openLocalFolder = async () => {
    const fsApi = window.fsApi;
    if (!fsApi) return;
    setBusy(true);
    setError(null);
    try {
      const root = await fsApi.addRoot();
      if (!root) return; // 用户取消选择器
      const existing = getFolders().find((f) => f.localRootId === root.id);
      const folder =
        existing ??
        (await createFolderMut.mutateAsync({
          name: root.name,
          localRootId: root.id,
        }));
      setFolder(folder.id);
      setCloud(false);
      setOpen(false);
    } catch {
      setError("打开文件夹失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  // chip 显示态：选定项目→项目名（本地 HardDrive/primary、云 Cloud/muted）；
  // 云端临时→Cloud；自动→Sparkles（muted）。
  const trigger: { icon: ReactNode; label: string } = selectedFolder
    ? {
        icon: selectedFolder.localRootId ? (
          <HardDrive size={14} className="shrink-0 text-primary" />
        ) : (
          <Cloud size={14} className="shrink-0 text-muted-foreground" />
        ),
        label: selectedFolder.name,
      }
    : pendingCloud
      ? {
          icon: <Cloud size={14} className="shrink-0 text-muted-foreground" />,
          label: "云端临时",
        }
      : {
          icon: (
            <Sparkles size={14} className="shrink-0 text-muted-foreground" />
          ),
          label: "自动",
        };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="选择对话工作区"
          title="选择这条对话的工作区（文件夹）"
          className="flex min-w-0 max-w-[160px] items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {trigger.icon}
          <span className="min-w-0 truncate">{trigger.label}</span>
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b border-border px-3 py-2.5">
          <div className="text-xs font-medium text-foreground">对话工作区</div>
          <div className="text-xs text-muted-foreground">
            选择这条对话在哪里工作
          </div>
        </div>

        <div className="max-h-[320px] overflow-y-auto p-1.5">
          <PickerRow
            icon={<Sparkles size={14} />}
            label="自动"
            hint={isDesktop ? "首次产生文件时在本地新建项目" : "在云端新建项目"}
            selected={!selectedFolder && !pendingCloud}
            onClick={pickAuto}
          />

          {recent.length > 0 && (
            <>
              <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
                最近项目
              </div>
              {recent.map((f) => (
                <PickerRow
                  key={f.id}
                  icon={
                    f.localRootId ? (
                      <HardDrive size={14} className="text-primary" />
                    ) : (
                      <Cloud size={14} />
                    )
                  }
                  label={f.name}
                  selected={selectedFolder?.id === f.id}
                  onClick={() => pickFolder(f.id)}
                />
              ))}
            </>
          )}

          <div className="my-1 border-t border-border" />

          {isDesktop && (
            <PickerRow
              icon={<FolderOpen size={14} />}
              label="打开本地文件夹…"
              onClick={() => void openLocalFolder()}
              disabled={busy}
            />
          )}
          {isDesktop && (
            <PickerRow
              icon={<Cloud size={14} />}
              label="云端临时对话"
              selected={pendingCloud}
              onClick={pickCloud}
            />
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

/** A full-width action row inside the picker popover. */
function PickerRow({
  icon,
  label,
  hint,
  selected,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      {selected && <Check size={14} className="shrink-0 text-primary" />}
    </button>
  );
}
