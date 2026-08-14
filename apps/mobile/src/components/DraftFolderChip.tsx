import { listCloudFolders } from "@/api/folders";
import type { FolderSummary } from "@/api/folders";
import { Modal } from "@/components/Modal";
import { Check, ChevronRight, Folder } from "lucide-react";
import { useEffect, useState } from "react";

export interface DraftFolder {
  id: string;
  name: string;
}

/**
 * 草稿「在哪张桌子上聊」：默认快速对话（裸聊）；可点选已有云文件夹。
 * 不开放新建 / 导入 / Git / 本机——生命周期仍归桌面。
 */
export function DraftFolderChip({
  value,
  onChange,
}: {
  value: DraftFolder | null;
  onChange: (next: DraftFolder | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="draft-folder-chip"
        data-testid="draft-folder-chip"
        aria-label={
          value ? `在文件夹「${value.name}」中对话` : "快速对话（不选文件夹）"
        }
        onClick={() => setOpen(true)}
      >
        <Folder size={14} aria-hidden />
        <span className="draft-folder-chip-label">
          {value ? value.name : "快速对话"}
        </span>
        <ChevronRight size={14} aria-hidden />
      </button>
      {open && (
        <FolderPickSheet
          selectedId={value?.id ?? null}
          onClose={() => setOpen(false)}
          onPick={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function FolderPickSheet({
  selectedId,
  onClose,
  onPick,
}: {
  selectedId: string | null;
  onClose: () => void;
  onPick: (next: DraftFolder | null) => void;
}) {
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCloudFolders()
      .then((rows) => {
        if (!cancelled) setFolders(rows);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "加载文件夹失败");
          setFolders([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Modal className="sheet" onClose={onClose} label="在哪聊">
      <div className="sheet-title">在哪聊</div>
      <p className="muted hint">
        选一个已有的云文件夹，或快速对话。新建文件夹请用桌面端。
      </p>
      <button
        type="button"
        className="sheet-item folder-pick-row"
        data-testid="draft-folder-bare"
        onClick={() => onPick(null)}
      >
        <span className="folder-pick-main">
          <span>快速对话</span>
          <span className="muted hint">不选文件夹，需要时会自动建</span>
        </span>
        {selectedId === null && <Check size={16} aria-label="已选" />}
      </button>
      {folders === null && !error && <p className="muted hint">加载中…</p>}
      {error && <p className="error hint">{error}</p>}
      {folders?.length === 0 && !error && (
        <p className="muted hint">
          还没有云文件夹。在桌面端新建后会出现在这里。
        </p>
      )}
      {folders?.map((f) => (
        <button
          key={f.id}
          type="button"
          className="sheet-item folder-pick-row"
          onClick={() => onPick({ id: f.id, name: f.name })}
        >
          <span className="folder-pick-main">
            <span>{f.name}</span>
            {f.rel_path?.includes("/") && (
              <span className="muted hint">{f.rel_path}</span>
            )}
          </span>
          {selectedId === f.id && <Check size={16} aria-label="已选" />}
        </button>
      ))}
    </Modal>
  );
}
