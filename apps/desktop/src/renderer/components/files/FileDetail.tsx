import { MarkdownFileEditor } from "@/components/files/MarkdownFileEditor";
import { FilePreviewView } from "@/components/workspace/FilePreviewView";
import type { FileSource } from "@/lib/fileSource";

const MARKDOWN_EXTS = new Set([".md", ".markdown"]);

/** 源路径 / 文件名的小写扩展名（含点；无扩展名为 ""）。 */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/**
 * 单个文件的「详情」渲染：按类型 + 源能力挑编辑器，是 swap 式 {@link FileBrowser} 与
 * split 式 {@link FileWorkbench} 共用的唯一出口——避免「哪种文件用哪个编辑器」的判断
 * 在两处各写一份而分叉。
 *
 * - `.md/.markdown` 且源可编辑（`caps.edit` + `readForEdit` + `writeText`）→ CodeMirror
 *   源码编辑器（{@link MarkdownFileEditor}）。
 * - 其余 → 只读预览 + 简易整文编辑（{@link FilePreviewView}）。
 *
 * `key=path` 由调用方保证切文件即重挂（两个编辑器都靠卸载冲刷未保存内容）。
 */
export function FileDetail({
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
  const editable =
    MARKDOWN_EXTS.has(extOf(name)) &&
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
      />
    );
  }
  return (
    <FilePreviewView
      source={source}
      path={path}
      name={name}
      onClose={onClose}
    />
  );
}
