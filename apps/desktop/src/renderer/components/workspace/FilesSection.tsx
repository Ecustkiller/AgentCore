import { FileTree } from "@/components/files/FileTree";
import { createWorkspaceSource } from "@/services/sources/workspaceSource";
import { useMemo, useState } from "react";
import { FilePreviewView } from "./FilePreviewView";

/**
 * 对话工作区的文件面板 = 共用 {@link FileTree} 的 n=1 实例（文件中枢统一 Step 0/3）：
 * 整个面板就是「挂一个 WorkspaceSource 的树」。点文件在面板内开 FilePreviewView
 * （可编辑、可下载）。树构建 / 增删改 / 拖拽移动 / 上传 / 折叠态全部下沉到共用
 * 组件，本文件只负责「选哪个源」与「预览开关」。
 */
export function FilesSection({ conversationId }: { conversationId: string }) {
  const source = useMemo(
    () => createWorkspaceSource(conversationId),
    [conversationId],
  );
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
