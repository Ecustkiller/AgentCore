import { FileDetail } from "@/components/files/FileDetail";
import {
  FileTree,
  type FileTreeChromeState,
  type FileTreeHandle,
} from "@/components/files/FileTree";
import { IconButton } from "@/components/files/parts";
import type { FileSource } from "@/lib/fileSource";
import {
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

/**
 * The source-agnostic file UI = a {@link FileTree} (n=1 source) that swaps to an
 * in-panel {@link FileDetail} when a file is opened. This is the **swap** variant,
 * for the *narrow* conversation side panel ({@link FilesSection}, keyed by
 * conversation) where tree + detail can't sit side by side. The cross-project 文件
 * hub uses the **split** variant ({@link FileWorkbench}) instead. Both share the leaf
 * surfaces (FileTree / FileDetail), so "which editor for this file" has one home
 * (FileDetail).
 *
 * 单行面板头：本组件持有唯一一条工具栏，左侧嵌 `leading`（工作区/云端选择器）、中段是
 * 文件操作（上传 / 新建 / 折叠 / 刷新，全部经 {@link FileTreeHandle} ref 驱动内部那棵树）、
 * 右侧嵌 `trailing`（快照 / 交接）。这条头常驻在树↔详情切换之上，故预览文件时 `leading`/
 * `trailing` 不会消失；树未挂载时文件操作淡出（disabled）。
 */
export function FileBrowser({
  source,
  leading,
  trailing,
}: {
  source: FileSource;
  /** 工具栏最左槽（如云端/本地工作区选择器），常驻、不随预览消失。 */
  leading?: ReactNode;
  /** 工具栏最右槽（如快照 / 交接入口），常驻、不随预览消失。 */
  trailing?: ReactNode;
}) {
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(
    null,
  );
  const treeRef = useRef<FileTreeHandle>(null);
  const [chrome, setChrome] = useState<FileTreeChromeState>({
    uploading: false,
    hasExpanded: false,
    loading: false,
  });

  // 预览时树未挂载（被 FileDetail 取代），针对树的操作此刻无的放矢 → 淡出禁用；
  // leading / trailing 是工作区级、与具体文件无关，保持常亮。
  const treeIdle = preview !== null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {leading}
        {leading && <div className="mx-1 h-4 w-px shrink-0 bg-border" />}

        {source.caps.transfer && (
          <button
            type="button"
            onClick={() => treeRef.current?.triggerUpload()}
            disabled={treeIdle || chrome.uploading}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {chrome.uploading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Upload size={13} />
            )}
            上传
          </button>
        )}
        <IconButton
          title="新建文件"
          disabled={treeIdle}
          onClick={() => treeRef.current?.startCreate("file")}
        >
          <FilePlus size={14} />
        </IconButton>
        <IconButton
          title="新建文件夹"
          disabled={treeIdle}
          onClick={() => treeRef.current?.startCreate("dir")}
        >
          <FolderPlus size={14} />
        </IconButton>

        <div className="min-w-0 flex-1" />

        {!treeIdle && chrome.hasExpanded && (
          <IconButton
            title="全部折叠"
            onClick={() => treeRef.current?.collapseAll()}
          >
            <ChevronsDownUp size={14} />
          </IconButton>
        )}
        <IconButton
          title="刷新"
          disabled={treeIdle}
          spinning={!treeIdle && chrome.loading}
          onClick={() => treeRef.current?.refresh()}
        >
          <RefreshCw size={14} />
        </IconButton>

        {trailing && <div className="mx-1 h-4 w-px shrink-0 bg-border" />}
        {trailing}
      </div>

      <div className="min-h-0 flex-1">
        {preview ? (
          // key=path 切文件即重挂编辑器（靠卸载冲刷未保存内容）。
          <FileDetail
            key={preview.path}
            source={source}
            path={preview.path}
            name={preview.name}
            onClose={() => setPreview(null)}
          />
        ) : (
          <FileTree
            ref={treeRef}
            source={source}
            hideToolbar
            onChromeState={setChrome}
            onOpenFile={(path, name) => setPreview({ path, name })}
          />
        )}
      </div>
    </div>
  );
}
