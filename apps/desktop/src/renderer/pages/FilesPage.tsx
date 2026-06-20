import { FileWorkbench } from "@/components/files/FileWorkbench";
import {
  useCreateFolder,
  useDeleteFolder,
  useUpdateFolder,
} from "@/hooks/useFolders";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { notifyError } from "@/lib/toast";
import { useFoldersStore } from "@/stores/folders";
import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * The 文件 hub (跨工作区文件总览) — one place to browse files across *all* the
 * user's workspaces (= folders, cloud + local) without first opening a
 * conversation. Layout is VSCode 式左树右详情: the left rail ({@link FileWorkbench})
 * stacks every workspace as a flat, non-collapsible section over its own
 * {@link FileSource} (cloud → REST, local → desktop IPC), all 平铺、无分区, told apart
 * only by a cloud/local badge — every workspace is equal (工作区对称化 D1a 起无置顶的
 * 默认壳；裸聊产文件时由服务端懒建一个 per 对话本地工作区，自然出现在这里)。The right
 * pane shows the selected file's preview / editor, with the tree always visible.
 *
 * This page is the cross-project *lens* and also **hosts folder lifecycle** (rename
 * / delete / new folder / add local) — it owns the data (`GET /v1/workspaces`) and
 * the folder mutations, handing the workbench plain callbacks. It is the **file**
 * lens; chats live on `/conversations`. The two cross-link (双模式工作区 决策 #9,
 * 端态 I): a project's「查看对话」jumps to `/conversations` filtered to that folder,
 * and `/conversations`「浏览文件」jumps back here with `focusWsId` (read off the
 * navigation state) so the target root expands + highlights. 一条裸聊在懒建出工作区
 * 之前不在这里出现（无工作区）。
 */
export function FilesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const query = useWorkspaces();
  const workspaces = useMemo(() => query.data ?? [], [query.data]);

  // 从 /conversations「浏览文件」跳来时携带的目标工作区（`folder:<id>`）。location.key 每次
  // 导航唯一，传给 workbench 作为「本次聚焦」的触发键（同一项目可重复聚焦）。
  const focusWsId =
    (location.state as { focusWsId?: string } | null)?.focusWsId ?? null;

  const fsApi = typeof window !== "undefined" ? window.fsApi : undefined;

  const createFolderMutation = useCreateFolder();
  const updateFolderMutation = useUpdateFolder();
  const deleteFolderMutation = useDeleteFolder();
  const setPendingRename = useFoldersStore((s) => s.setPendingRename);

  // 新建云端项目（空文件夹）——建好后直接进重命名（pendingRename 驱动根节点内联改名）。
  const handleNewFolder = async () => {
    try {
      const folder = await createFolderMutation.mutateAsync({
        name: "新建文件夹",
      });
      setPendingRename(folder.id);
    } catch (err) {
      notifyError(err, "新建文件夹失败");
    }
  };

  // 添加本地文件夹 = 选 OS 目录一步建本地绑定项目（双模式工作区 决策 #7 / F2）：
  // 选目录拿到桌面 FS 根，再带 localRootId 单条建文件夹，免 create-then-bind。
  const handleAddLocal = async () => {
    if (!fsApi) return;
    try {
      const root = await fsApi.addRoot();
      if (!root) return; // user cancelled the OS picker
      await createFolderMutation.mutateAsync({
        name: root.name,
        localRootId: root.id,
      });
    } catch (err) {
      notifyError(err, "添加本地文件夹失败");
    }
  };

  return (
    <FileWorkbench
      workspaces={workspaces}
      isLoading={query.isLoading}
      isError={query.isError}
      onRetry={() => void query.refetch()}
      fsAvailable={!!fsApi}
      onNewFolder={() => void handleNewFolder()}
      onAddLocal={() => void handleAddLocal()}
      onRename={(folderId, name) =>
        updateFolderMutation.mutate({ id: folderId, patch: { name } })
      }
      onDelete={(folderId) => deleteFolderMutation.mutate(folderId)}
      onViewConversations={(folderId) =>
        navigate("/conversations", { state: { focusFolderId: folderId } })
      }
      focusWsId={focusWsId}
      focusKey={location.key}
    />
  );
}
