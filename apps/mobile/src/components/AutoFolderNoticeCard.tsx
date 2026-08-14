import { renameFolder } from "@/api/folders";
import { folderWorkspaceId } from "@/lib/cloudFolder";
import { ChevronRight, FolderPlus } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export interface AutoFolderNotice {
  folderId: string;
  name: string;
}

/** fold 优先；冷加载 lifted `runs.auto_folder` 兜底。 */
export function autoFolderFromSources(
  folded: AutoFolderNotice | null | undefined,
  lifted: { folder_id: string; name: string } | null | undefined,
): AutoFolderNotice | null {
  if (folded?.folderId) return folded;
  if (lifted?.folder_id) {
    return { folderId: lifted.folder_id, name: lifted.name };
  }
  return null;
}

/**
 * 裸聊写盘落点告知（双模式工作区 §5.4）：告知不是审批，忽略也照旧。
 * 有产出文件时走 {@link AutoFolderNoticeLine}（卡头一行）；没有时走独立卡。
 */
function AutoFolderNoticeBody({
  notice,
  lead,
}: {
  notice: AutoFolderNotice;
  lead: string;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(notice.name);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notice.name);
  const [error, setError] = useState<string | null>(null);
  const skipBlurRef = useRef(false);

  const openFolder = () => {
    navigate(
      `/files/${encodeURIComponent(folderWorkspaceId(notice.folderId))}`,
      {
        state: { name },
      },
    );
  };

  const commitEdit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === name) return;
    setError(null);
    void renameFolder(notice.folderId, next)
      .then((f) => setName(f.name))
      .catch((e) => setError(e instanceof Error ? e.message : "重命名失败"));
  };

  return (
    <div className="auto-folder-notice" data-testid="auto-folder-notice">
      <FolderPlus size={14} className="auto-folder-notice-icon" aria-hidden />
      <div className="auto-folder-notice-body">
        <span className="muted">{lead}</span>
        {editing ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: 用户刚点「改名」，焦点就该在输入框
            autoFocus
            aria-label="文件夹名"
            className="auto-folder-notice-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                skipBlurRef.current = true;
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (skipBlurRef.current) {
                skipBlurRef.current = false;
                return;
              }
              commitEdit();
            }}
          />
        ) : (
          <>
            <button
              type="button"
              className="auto-folder-notice-name"
              onClick={openFolder}
            >
              <span className="auto-folder-notice-label">{name}</span>
              <ChevronRight size={13} aria-hidden />
            </button>
            <button
              type="button"
              className="auto-folder-notice-rename"
              onClick={() => {
                setDraft(name);
                setEditing(true);
              }}
            >
              改名
            </button>
          </>
        )}
        {error && <span className="error hint">{error}</span>}
      </div>
    </div>
  );
}

export function AutoFolderNoticeLine({ notice }: { notice: AutoFolderNotice }) {
  return (
    <div className="auto-folder-notice-line">
      <AutoFolderNoticeBody notice={notice} lead="文件已存到新建的文件夹" />
    </div>
  );
}

export function AutoFolderNoticeCard({ notice }: { notice: AutoFolderNotice }) {
  return (
    <div
      className="auto-folder-notice-card"
      data-testid="auto-folder-notice-card"
    >
      <AutoFolderNoticeBody notice={notice} lead="已为这次对话新建文件夹" />
    </div>
  );
}
