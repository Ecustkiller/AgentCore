import type { DownloadedFile, WorkspaceListing } from "@/api/workspace";
import {
  createWorkspaceDirByWs,
  deleteWorkspaceEntryByWs,
  downloadWorkspaceFileByWs,
  listWorkspaceFilesByWs,
  listWorkspaceTrashByWs,
  moveWorkspaceEntryByWs,
  readWorkspaceFileForEditByWs,
  restoreWorkspaceTrashByWs,
  uploadWorkspaceFileByWs,
  writeWorkspaceFileTextByWs,
} from "@/api/workspaces";
import { FileBrowser, type FileBrowserSource } from "@/components/FileBrowser";
import { TrashSection, type TrashSource } from "@/components/TrashSection";
import type { FileBrowserOps } from "@/components/fileBrowser/ops";
import { toWorkspaceRelPath } from "@/lib/workspacePath";
// Browse ONE cloud workspace's files (手机端布局重构 · 跨工作区文件总览).
//
// The drill-down from the 文件 tab (/files → /files/:wsId). Keeps the bottom tab bar (a
// within-tab push), with a 「← 我的文件」back to the workspace list. Renders the shared
// <FileBrowser> over a first-class workspace source (api/workspaces.ts), the cross-workspace
// sibling of the per-conversation /c/:id/files. The workspace name rides in router state from
// the list so the header shows it without a refetch.
// 协作摘要已从本页拿掉：本页只管「这个工作区里的文件」；项目协作时间线留桌面（手机暂无入口）。
// 聊天产物卡带 workspace_id 时也会深链到此页（openPath + fromConversationId）。
//
// 云工作区在手机上可写：文件的改名 / 移动 / 删除 / 新建文件夹 / 文本编辑都在这里。
// 工作区**自身**的生命周期（新建、改名、删除工作区、绑定本机文件夹）仍是桌面的活。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

type WorkspaceFilesState = {
  name?: string;
  openPath?: string;
  fromConversationId?: string;
} | null;

export function WorkspaceFilesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { wsId = "" } = useParams<{ wsId: string }>();
  const state = location.state as WorkspaceFilesState;
  const name = state?.name ?? "工作区";
  const rawOpenPath = state?.openPath ?? null;
  const openPath = rawOpenPath
    ? toWorkspaceRelPath(rawOpenPath) || rawOpenPath
    : null;
  const fromConversationId = state?.fromConversationId ?? null;

  const [cwd, setCwd] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Reset to root when switching to a different workspace (the component is reused across
  // /files/:wsId param changes, so state would otherwise leak across workspaces).
  // biome-ignore lint/correctness/useExhaustiveDependencies: wsId is the intentional trigger — the reset must run on every workspace switch even though the body doesn't read it
  useEffect(() => {
    setCwd("");
    setUploadError(null);
    setTrashOpen(false);
  }, [wsId]);

  const source = useMemo<FileBrowserSource>(
    () => ({
      list: (): Promise<WorkspaceListing> => listWorkspaceFilesByWs(wsId),
      download: (path: string): Promise<DownloadedFile> =>
        downloadWorkspaceFileByWs(wsId, path),
    }),
    [wsId],
  );

  const ops = useMemo<FileBrowserOps>(
    () => ({
      move: (src, dst) => moveWorkspaceEntryByWs(wsId, src, dst),
      remove: (path) => deleteWorkspaceEntryByWs(wsId, path),
      createDir: (path) => createWorkspaceDirByWs(wsId, path),
      readForEdit: (path) => readWorkspaceFileForEditByWs(wsId, path),
      writeText: (path, input) => writeWorkspaceFileTextByWs(wsId, path, input),
    }),
    [wsId],
  );

  const trashSource = useMemo<TrashSource>(
    () => ({
      list: () => listWorkspaceTrashByWs(wsId),
      restore: (entryId) => restoreWorkspaceTrashByWs(wsId, entryId),
    }),
    [wsId],
  );

  const onPickUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !wsId) return;
      const target = cwd ? `${cwd}/${file.name}` : file.name;
      setUploading(true);
      setUploadError(null);
      try {
        await uploadWorkspaceFileByWs(wsId, target, file);
        setReloadKey((k) => k + 1);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "上传失败");
      } finally {
        setUploading(false);
      }
    },
    [wsId, cwd],
  );

  const onBack = () => {
    if (fromConversationId) {
      navigate(`/c/${fromConversationId}`);
      return;
    }
    navigate("/files");
  };

  if (trashOpen) {
    return (
      <div className="screen">
        <header className="bar">
          <button
            type="button"
            className="link"
            onClick={() => setTrashOpen(false)}
          >
            ← 返回
          </button>
          <span className="viewer-name">软删区</span>
          <span className="bar-right" aria-hidden />
        </header>
        <TrashSection
          source={trashSource}
          onRestored={() => setReloadKey((k) => k + 1)}
        />
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="bar">
        <button type="button" className="link" onClick={onBack}>
          {fromConversationId ? "← 返回" : "← 我的文件"}
        </button>
        <span className="viewer-name">{name}</span>
        <div className="bar-right">
          <button
            type="button"
            className="link"
            onClick={() => setTrashOpen(true)}
            aria-label="软删区"
          >
            软删区
          </button>
          <button
            type="button"
            className="link"
            onClick={() => uploadInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "上传中…" : "上传"}
          </button>
        </div>
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*,.pdf,.md,.markdown,.txt,.json,.csv,.html,.css,.js,.ts,.tsx,.py,.zip,text/*"
          style={{ display: "none" }}
          onChange={(e) => void onPickUpload(e)}
        />
      </header>

      <FileBrowser
        source={source}
        cwd={cwd}
        onCwdChange={setCwd}
        reloadKey={reloadKey}
        openPath={openPath}
        emptyHint="此工作区还没有文件。"
        onUpload={() => uploadInputRef.current?.click()}
        ops={ops}
      />

      {uploadError && <div className="error bar">{uploadError}</div>}
    </div>
  );
}
