import { FileTree } from "@/components/files/FileTree";
import type { FileSource } from "@/lib/fileSource";
import { useState } from "react";
import { FilePreviewView } from "./FilePreviewView";

/**
 * The source-agnostic file UI = a {@link FileTree} (n=1 source) that swaps to an
 * in-panel {@link FilePreviewView} when a file is opened. This is the whole
 * "browse one workspace's files" surface, shared by the conversation side panel
 * ({@link FilesSection}, keyed by conversation) and the folder workspace overview
 * ({@link WorkspacePage}, keyed by the folder's `folder:<id>` / local root). The
 * caller decides which {@link FileSource} to mount; everything else (tree build /
 * CRUD / drag-move / upload / collapse state / preview) lives below here.
 */
export function FileBrowser({ source }: { source: FileSource }) {
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(
    null,
  );

  if (preview) {
    return (
      <FilePreviewView
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
