import {
  type DownloadedFile,
  type WorkspaceFileEntry,
  downloadWorkspaceFile,
  getWorkspaceBinding,
  listWorkspaceFiles,
  uploadWorkspaceFile,
} from "@/api/workspace";
import { FileBrowser, type FileBrowserSource } from "@/components/FileBrowser";
import { TrashSection } from "@/components/TrashSection";
import { LOCAL_WORKSPACE_MOBILE_HINT } from "@/lib/fileDownloadError";
import { toWorkspaceRelPath } from "@/lib/workspacePath";
// The cloud workspace file browser for ONE conversation (前端技术与架构 §七 · 云端文件浏览).
//
// Reachable from the chat header (/c/:id/files) — a full-screen, conversation-scoped shortcut
// (no bottom tab bar). Soft-delete zone (AgentCore/trash list+restore) toggles in-place —
// same page as the file tree (对齐桌面 TrashSection 语义；非 OS 回收站).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

export function FilesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: conversationId } = useParams<{ id: string }>();
  // 一键直达：从聊天「本回合产出文件」卡跳来时带着要打开的文件路径（router state）。
  const rawOpenPath =
    (location.state as { openPath?: string } | null)?.openPath ?? null;
  const openPath = rawOpenPath
    ? toWorkspaceRelPath(rawOpenPath) || rawOpenPath
    : null;
  const [cwd, setCwd] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [localMode, setLocalMode] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    getWorkspaceBinding(conversationId)
      .then((b) => {
        if (!cancelled) setLocalMode(b.mode === "local");
      })
      .catch(() => {
        if (!cancelled) setLocalMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // The conversation's workspace as a FileBrowser source — stable per conversation so the
  // browser resets to root only when the conversation changes (not on an upload reload).
  const source = useMemo<FileBrowserSource>(
    () => ({
      list: (): Promise<WorkspaceFileEntry[]> =>
        listWorkspaceFiles(conversationId ?? ""),
      download: (path: string): Promise<DownloadedFile> =>
        downloadWorkspaceFile(conversationId ?? "", path),
    }),
    [conversationId],
  );

  const onPickUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-picking the same file after an error
      if (!file || !conversationId) return;
      const target = cwd ? `${cwd}/${file.name}` : file.name;
      setUploading(true);
      setUploadError(null);
      try {
        await uploadWorkspaceFile(conversationId, target, file);
        setReloadKey((k) => k + 1); // refresh so the new file shows in the current folder
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "上传失败");
      } finally {
        setUploading(false);
      }
    },
    [conversationId, cwd],
  );

  if (trashOpen && conversationId) {
    return (
      <div className="screen">
        <header className="bar">
          <button
            type="button"
            className="link"
            onClick={() => setTrashOpen(false)}
          >
            ← 文件
          </button>
          <span>软删区</span>
          <span className="bar-right" aria-hidden />
        </header>
        <TrashSection
          conversationId={conversationId}
          onRestored={() => setReloadKey((k) => k + 1)}
        />
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="bar">
        <button
          type="button"
          className="link"
          onClick={() => navigate(`/c/${conversationId}`)}
        >
          ← 返回
        </button>
        <span>文件</span>
        <div className="bar-right">
          <button
            type="button"
            className="link"
            onClick={() => setTrashOpen(true)}
            aria-label="软删区"
            disabled={localMode}
          >
            软删区
          </button>
          <button
            type="button"
            className="link"
            onClick={() => uploadInputRef.current?.click()}
            disabled={uploading || localMode}
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

      {localMode && (
        <p className="muted hint" style={{ padding: "8px 16px", margin: 0 }}>
          {LOCAL_WORKSPACE_MOBILE_HINT}
        </p>
      )}

      <FileBrowser
        source={source}
        cwd={cwd}
        onCwdChange={setCwd}
        reloadKey={reloadKey}
        openPath={localMode ? null : openPath}
        emptyHint={
          localMode ? LOCAL_WORKSPACE_MOBILE_HINT : "此对话还没有工作区文件。"
        }
        onUpload={localMode ? undefined : () => uploadInputRef.current?.click()}
      />

      {uploadError && <div className="error bar">{uploadError}</div>}
    </div>
  );
}
