import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import { type PendingAttachment, readDroppedFile } from "./composerAttachments";

export function useComposerDrop(
  isGenerating: boolean,
  attachments: PendingAttachment[],
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>,
) {
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const dropErrorTimer = useRef<number | null>(null);

  const flashDropError = useCallback((msg: string) => {
    setDropError(msg);
    if (dropErrorTimer.current) window.clearTimeout(dropErrorTimer.current);
    dropErrorTimer.current = window.setTimeout(() => setDropError(null), 3000);
  }, []);

  const attachDroppedFile = useCallback(
    async (file: File) => {
      const key = `dropped:${file.name}:${file.size}`;
      if (attachments.some((a) => a.key === key)) return;
      const res = await readDroppedFile(file);
      if (!res.ok) {
        flashDropError(res.reason);
        return;
      }
      setAttachments((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          key,
          name: file.name,
          path: file.name,
          text: res.text,
          truncated: res.truncated,
          kind: "file",
        },
      ]);
    },
    [attachments, flashDropError, setAttachments],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (isGenerating || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragOver(true);
    },
    [isGenerating],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);

  // 粘贴入框 (对话基础功能补齐): Ctrl/Cmd+V of a file (or a screenshot) attaches it via
  // the SAME path as drop — so a clipboard image hits the same「暂不支持图片附件」guard,
  // one attachment pipeline, no second policy. Plain-text paste carries no files, so we
  // never intercept it — the textarea inserts the text as usual.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (isGenerating) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void (async () => {
        for (const f of files) await attachDroppedFile(f);
      })();
    },
    [isGenerating, attachDroppedFile],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragOver(false);
      if (isGenerating) return;
      const dropped: File[] = [];
      let sawDir = false;
      const items = Array.from(e.dataTransfer.items ?? []);
      if (items.length) {
        for (const item of items) {
          if (item.kind !== "file") continue;
          if (item.webkitGetAsEntry?.()?.isDirectory) {
            sawDir = true;
            continue;
          }
          const f = item.getAsFile();
          if (f) dropped.push(f);
        }
      } else {
        dropped.push(...Array.from(e.dataTransfer.files));
      }
      for (const f of dropped) await attachDroppedFile(f);
      if (sawDir) flashDropError("文件夹请用 @ 引用，拖拽仅支持文件");
    },
    [isGenerating, attachDroppedFile, flashDropError],
  );

  const disposeDropTimer = useCallback(() => {
    if (dropErrorTimer.current) window.clearTimeout(dropErrorTimer.current);
  }, []);

  return {
    dragOver,
    dropError,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
    disposeDropTimer,
  };
}
