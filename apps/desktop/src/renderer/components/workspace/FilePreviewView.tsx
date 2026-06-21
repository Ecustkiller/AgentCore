import { FilePreviewBody } from "@/components/files/FilePreviewBody";
import { Centered, InlineError } from "@/components/files/parts";
import { Button, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { FilePreviewResult, FileSource } from "@/lib/fileSource";
import { notifyActionError, notifyError } from "@/lib/toast";
import {
  ChevronLeft,
  Download,
  ExternalLink,
  FileText,
  FolderSearch,
  Loader2,
  Pencil,
  Save,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * In-panel preview of one file from a {@link FileSource}, with opt-in editing for
 * whole text files. Takes over the files section (with a back arrow); a header
 * download button (when the source can transfer) pulls the raw file. Binary /
 * oversized files fall back to a download-only notice. Saving writes the buffer
 * back through the source's `writeBytes` (gated by `caps.edit`).
 */
export function FilePreviewView({
  source,
  path,
  name,
  onClose,
}: {
  source: FileSource;
  path: string;
  name: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<FilePreviewResult | null>(null);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setResult(null);
    setError(false);
    setEditing(false);
    try {
      setResult(await source.read(path));
    } catch {
      setError(true);
    }
  }, [source, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDownload = async () => {
    if (downloading || !source.download) return;
    setDownloading(true);
    try {
      await source.download(path, name);
    } catch {
      /* transient; the header button just re-enables */
    } finally {
      setDownloading(false);
    }
  };

  // 系统集成（仅本地源实现这两个方法 → 按存在性显隐，不按源分支）。
  const onReveal = async () => {
    try {
      await source.revealInOsFileManager?.(path);
    } catch (e) {
      notifyActionError("无法在资源管理器中显示", e);
    }
  };
  const onOpenExternal = async () => {
    try {
      await source.openWithOsDefaultApp?.(path);
    } catch (e) {
      notifyActionError("无法用默认程序打开", e);
    }
  };

  // Editing is offered only for a whole text file on a source that can write it
  // back: a truncated preview would drop its tail on save, so oversized/binary
  // stay read-only (download).
  const canEdit =
    result?.kind === "text" &&
    !result.truncated &&
    source.caps.edit &&
    !!source.writeBytes;
  const dirty = editing && result?.kind === "text" && draft !== result.text;

  const startEdit = () => {
    if (result?.kind === "text" && !result.truncated) {
      setDraft(result.text);
      setEditing(true);
    }
  };

  const onSave = useCallback(async () => {
    if (saving || !source.writeBytes) return;
    setSaving(true);
    try {
      await source.writeBytes(path, new Blob([draft]));
      setResult({ kind: "text", text: draft, truncated: false });
      setEditing(false);
    } catch {
      notifyError("保存失败");
    } finally {
      setSaving(false);
    }
  }, [saving, source, path, draft]);

  // Confirm before discarding unsaved edits (back to list, or cancel editing).
  const requestClose = () => {
    if (dirty && !window.confirm("有未保存的改动，确定放弃并返回？")) return;
    onClose();
  };
  const cancelEdit = () => {
    if (dirty && !window.confirm("有未保存的改动，确定放弃编辑？")) return;
    setEditing(false);
  };

  // Ctrl/Cmd+S saves while editing (and swallows the browser's save dialog).
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, onSave]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border pl-1 pr-1">
        <SimpleTooltip label="返回文件列表">
          <IconButton onClick={requestClose} aria-label="返回文件列表">
            <ChevronLeft size={16} />
          </IconButton>
        </SimpleTooltip>
        <FileText size={13} className="shrink-0 text-muted-foreground" />
        <SimpleTooltip label={path}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {dirty && <span className="text-primary">● </span>}
            {name}
          </span>
        </SimpleTooltip>
        {editing ? (
          <>
            <Button
              className="shrink-0 disabled:opacity-60"
              disabled={saving}
              onClick={() => void onSave()}
              icon={
                saving ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Save size={13} />
                )
              }
            >
              保存
            </Button>
            <SimpleTooltip label="取消编辑">
              <IconButton onClick={cancelEdit} aria-label="取消编辑">
                <X size={14} />
              </IconButton>
            </SimpleTooltip>
          </>
        ) : (
          <>
            {canEdit && (
              <SimpleTooltip label="编辑">
                <IconButton onClick={startEdit} aria-label="编辑">
                  <Pencil size={14} />
                </IconButton>
              </SimpleTooltip>
            )}
            {source.openWithOsDefaultApp && (
              <SimpleTooltip label="用默认程序打开">
                <IconButton
                  onClick={() => void onOpenExternal()}
                  aria-label="用默认程序打开"
                >
                  <ExternalLink size={14} />
                </IconButton>
              </SimpleTooltip>
            )}
            {source.revealInOsFileManager && (
              <SimpleTooltip label="在资源管理器中显示">
                <IconButton
                  onClick={() => void onReveal()}
                  aria-label="在资源管理器中显示"
                >
                  <FolderSearch size={14} />
                </IconButton>
              </SimpleTooltip>
            )}
            {source.download && (
              <SimpleTooltip label="下载文件">
                <IconButton
                  disabled={downloading}
                  onClick={() => void onDownload()}
                  aria-label="下载文件"
                >
                  {downloading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Download size={14} />
                  )}
                </IconButton>
              </SimpleTooltip>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="block h-full w-full resize-none border-0 bg-transparent px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none"
          />
        ) : error ? (
          <InlineError onRetry={() => void load()} />
        ) : result === null ? (
          <Centered>
            <Loader2
              size={18}
              className="animate-spin text-muted-foreground/50"
            />
          </Centered>
        ) : (
          <FilePreviewBody result={result} name={name} />
        )}
      </div>
    </div>
  );
}
