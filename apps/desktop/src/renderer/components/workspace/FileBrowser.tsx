import { FileDetail } from "@/components/files/FileDetail";
import { FileTree } from "@/components/files/FileTree";
import type { FileSource } from "@/lib/fileSource";
import { useState } from "react";

/**
 * The source-agnostic file UI = a {@link FileTree} (n=1 source) that swaps to an
 * in-panel {@link FileDetail} when a file is opened. This is the **swap** variant,
 * for *narrow* panels where tree + detail can't sit side by side: the conversation
 * side panel ({@link FilesSection}, keyed by conversation) and the folder workspace
 * overview ({@link WorkspacePage}). The cross-project 文件 hub uses the **split**
 * variant ({@link FileWorkbench}) instead. Both share the leaf surfaces (FileTree /
 * FileDetail), so "which editor for this file" has one home (FileDetail).
 */
export function FileBrowser({ source }: { source: FileSource }) {
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(
    null,
  );

  if (preview) {
    // key=path 切文件即重挂编辑器（靠卸载冲刷未保存内容）。
    return (
      <FileDetail
        key={preview.path}
        source={source}
        path={preview.path}
        name={preview.name}
        onClose={() => setPreview(null)}
      />
    );
  }

  return (
    <FileTree
      source={source}
      onOpenFile={(path, name) => setPreview({ path, name })}
    />
  );
}
