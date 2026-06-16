import { FilePreviewBody } from "@/components/files/FilePreviewBody";
import { Centered, IconButton, InlineError } from "@/components/files/parts";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { FilePreviewResult, FileSource } from "@/lib/fileSource";
import { notifyError } from "@/lib/toast";
import {
  ChevronLeft,
  Download,
  FileText,
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
          <button
            type="button"
            onClick={requestClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft size={16} />
          </button>
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
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              保存
            </button>
            <IconButton title="取消编辑" onClick={cancelEdit}>
              <X size={14} />
            </IconButton>
          </>
        ) : (
          <>
            {canEdit && (
              <IconButton title="编辑" onClick={startEdit}>
                <Pencil size={14} />
              </IconButton>
            )}
            {source.download && (
              <IconButton
                title="下载文件"
                onClick={() => void onDownload()}
                spinning={downloading}
              >
                <Download size={14} />
              </IconButton>
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
            className="block h-full w-full resize-none border-0 bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none"
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
