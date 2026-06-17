import { FileWorkbench } from "@/components/files/FileWorkbench";
import {
  useCreateFolder,
  useDeleteFolder,
  useUpdateFolder,
} from "@/hooks/useFolders";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { useFoldersStore } from "@/stores/folders";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

/**
 * The 文件 hub (跨工作区文件总览) — one place to browse files across *all* the
 * user's workspaces (= folders, cloud + local) without first opening a
 * conversation. Layout is VSCode 式左树右详情: the left rail is *one* multi-root
 * tree ({@link FileWorkbench}) where each workspace is a collapsible root over its
 * own {@link FileSource} (cloud → REST, local → desktop IPC); the right pane shows
 * the selected file's preview / editor, with the tree always visible.
 *
 * This page is the cross-project *lens* and also **hosts folder lifecycle** (rename
 * / delete / new folder / add local) — it owns the data (`GET /v1/workspaces`) and
 * the folder mutations, handing the workbench plain callbacks. `/folders/:id` stays
 * the single-project *home*; both read the same workspace enumeration and share the
 * file tree, so "which projects exist" has one source of truth (双模式工作区 决策
 * #9). 裸聊 has no workspace and never appears here.
 */
export function FilesPage() {
  const navigate = useNavigate();
  const query = useWorkspaces();
  const workspaces = useMemo(() => query.data ?? [], [query.data]);

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
    } catch {
      /* create failed (offline / 401); leave the page as-is */
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
    } catch {
      /* picker / create failed; leave the page as-is */
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
      onOpen={(folderId) => navigate(`/folders/${folderId}`)}
    />
  );
}
