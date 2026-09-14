import { MarkdownFileEditor } from "@/components/files/MarkdownFileEditor";
import { FilePreviewView } from "@/components/workspace/FilePreviewView";
import { type FileSource, isMarkdownPath } from "@/lib/fileSource";

export type FileDirtyState = {
  dirty: boolean;
  confirmDiscard: boolean;
};

/**
 * 单个文件的「详情」渲染：按类型 + 源能力挑编辑器，是 swap 式 {@link FileBrowser} 与
 * split 式 {@link FileWorkbench} 共用的唯一出口——避免「哪种文件用哪个编辑器」的判断
 * 在两处各写一份而分叉。
 *
 * 无论走哪个宿主，md 都「阅读优先」：点开先看渲染内容，编辑为次级动作。
 * - `.md/.markdown` 且源可编辑（`caps.edit` + `readForEdit` + `writeText`）→ {@link
 *   MarkdownFileEditor}：默认渲染预览，可切 CodeMirror 源码编辑。
 * - 其余 → {@link FilePreviewView}：只读 md 也默认渲染预览，非 md 走通用预览 + 简易整文编辑。
 *
 * 认路在宿主 TabChip；本组件只画动作条。`key=path` 由调用方保证切文件即重挂。
 */
export function FileDetail({
  source,
  path,
  name,
  onClose,
  onDirtyChange,
}: {
  source: FileSource;
  path: string;
  name: string;
  onClose: () => void;
  onDirtyChange?: (state: FileDirtyState) => void;
}) {
  const editable =
    isMarkdownPath(name) &&
    source.caps.edit &&
    !!source.readForEdit &&
    !!source.writeText;

  if (editable) {
    return (
      <MarkdownFileEditor
        source={source}
        path={path}
        name={name}
        onClose={onClose}
        hostedInTab
        onDirtyChange={onDirtyChange}
      />
    );
  }
  return (
    <FilePreviewView
      source={source}
      path={path}
      name={name}
      onDirtyChange={onDirtyChange}
    />
  );
}
