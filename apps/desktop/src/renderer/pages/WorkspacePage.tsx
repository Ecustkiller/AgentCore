import { EmptyHint } from "@/components/files/parts";
import { ConversationItem } from "@/components/sidebar/ConversationItem";
import { FileBrowser } from "@/components/workspace/FileBrowser";
import {
  useConversations,
  useGroupedConversations,
} from "@/hooks/useConversations";
import { useFolders } from "@/hooks/useFolders";
import { startNewConversation } from "@/lib/newConversation";
import { createLocalRootSource } from "@/services/sources/localRootSource";
import { createCloudWorkspaceSource } from "@/services/sources/workspaceSource";
import type { Conversation } from "@/stores/conversation";
import {
  ArrowLeft,
  Cloud,
  FolderOpen,
  HardDrive,
  MessageSquare,
  Plus,
} from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";

function byPinnedThenRecency(a: Conversation, b: Conversation): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
}

/**
 * Folder workspace overview (`/folders/:folderId`) — 文件夹即工作区 Phase 2: a
 * folder *is* a project, so this is its "open the project" view. It shows the
 * folder's files (browse without entering a conversation — the role the deleted
 * global file page used to serve, now scoped to one folder) alongside the chats
 * that live in it. Files come from the folder's own source: a bound local folder
 * reads the user's machine over IPC; a cloud folder reads its `folder:<id>`
 * server workspace over REST — the same seam the @ mention index uses.
 */
export function WorkspacePage() {
  const { folderId } = useParams<{ folderId: string }>();
  const folders = useFolders();
  const conversations = useConversations();
  const grouped = useGroupedConversations();
  const navigate = useNavigate();

  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;
  const folder = folders.find((f) => f.id === folderId) ?? null;
  const isLocal = !!folder?.localRootId;
  // A local folder reads the user's machine, so it only resolves on desktop; a
  // web build has no fsApi and shows a hint instead of the tree.
  const localUnavailable = isLocal && !fsApi;

  const source = useMemo(() => {
    if (!folder) return null;
    if (folder.localRootId) {
      if (!fsApi) return null;
      return createLocalRootSource(folder.localRootId, folder.name);
    }
    return createCloudWorkspaceSource(`folder:${folder.id}`, folder.name);
  }, [folder, fsApi]);

  const folderConversations = useMemo(
    () =>
      conversations
        .filter((c) => c.folderId === folderId)
        .sort(byPinnedThenRecency),
    [conversations, folderId],
  );

  // The grouped query is loaded once; until it resolves we can't tell "missing"
  // from "not yet loaded", so hold the not-found verdict until data is in.
  if (!folder) {
    return (
      <CenteredPage>
        <EmptyHint
          icon={<FolderOpen size={26} className="text-muted-foreground/40" />}
          title={grouped.data ? "文件夹不存在" : "加载中…"}
          hint={
            grouped.data ? "它可能已被删除或移动。" : "正在读取你的文件夹。"
          }
        />
        {grouped.data && (
          <button
            type="button"
            onClick={() => navigate("/conversations")}
            className="mt-3 text-sm text-primary hover:underline"
          >
            返回全部对话
          </button>
        )}
      </CenteredPage>
    );
  }

  return (
    <div className="h-full w-full overflow-hidden">
      <div className="mx-auto flex h-full max-w-[1200px] flex-col px-6 py-8">
        <header className="shrink-0">
          <button
            type="button"
            onClick={() => navigate("/conversations")}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={15} className="shrink-0" />
            全部对话
          </button>
          <div className="mt-2 flex items-center gap-2.5">
            <FolderOpen size={22} className="shrink-0 text-muted-foreground" />
            <h1 className="min-w-0 truncate text-xl font-semibold text-foreground">
              {folder.name}
            </h1>
            <span
              className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                isLocal
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {isLocal ? <HardDrive size={12} /> : <Cloud size={12} />}
              {isLocal ? "本地" : "云端"}
            </span>
            <div className="min-w-0 flex-1" />
            <button
              type="button"
              onClick={() => startNewConversation(navigate, folder.id)}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus size={16} className="shrink-0" />
              新建对话
            </button>
          </div>
        </header>

        <div className="mt-6 flex min-h-0 flex-1 gap-6">
          {/* Files — the project's contents, browsable without opening a chat. */}
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
              <FolderOpen
                size={13}
                className="shrink-0 text-muted-foreground"
              />
              <span className="text-xs font-medium text-foreground">文件</span>
            </div>
            <div className="min-h-0 flex-1">
              {localUnavailable ? (
                <EmptyHint
                  inline
                  icon={
                    <HardDrive size={26} className="text-muted-foreground/40" />
                  }
                  title="本地工作区"
                  hint="这个项目的文件在你的电脑上，请在桌面端查看。"
                />
              ) : source ? (
                <FileBrowser source={source} />
              ) : null}
            </div>
          </section>

          {/* Conversations that live in this folder. */}
          <section className="flex min-h-0 w-80 shrink-0 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-1.5 px-1">
              <MessageSquare
                size={13}
                className="shrink-0 text-muted-foreground"
              />
              <span className="text-xs font-medium text-foreground">对话</span>
              <span className="text-xs text-muted-foreground/60">
                {folderConversations.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {folderConversations.length === 0 ? (
                <EmptyHint
                  inline
                  icon={
                    <MessageSquare
                      size={26}
                      className="text-muted-foreground/40"
                    />
                  }
                  title="此文件夹暂无对话"
                  hint="点右上角「新建对话」在这个项目里开始。"
                />
              ) : (
                <div className="space-y-0.5">
                  {folderConversations.map((c) => (
                    <ConversationItem key={c.id} conversation={c} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Centered single-message frame for the loading / not-found states. */
function CenteredPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      {children}
    </div>
  );
}
