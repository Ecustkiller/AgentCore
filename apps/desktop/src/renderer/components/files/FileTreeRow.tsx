import { Button, SurfaceRow, surfaceRowIndent } from "@/components/ui";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { statusPillSoft } from "@/components/ui/tone-presets";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { FileNode, FileSource } from "@/lib/fileSource";
import {
  AGENTCORE_ROOT_LABEL,
  AGENTCORE_ROOT_TOOLTIP,
  countDescendantFiles,
  isAgentCoreRootDir,
  stageDirCaption,
  stageDirMeta,
} from "@/lib/stageDirs";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type React from "react";
import { InlineCreateRow, InlineInput, InlineRow } from "./FileTreeInline";
import { FileTreeRowMenu } from "./FileTreeRowMenu";
import { FileTypeIcon } from "./FileTypeIcon";
import { DRAG_MIME, type DragPayload, parseDragPayload } from "./fileTreeDrag";
import { FileRowMeta, TruncatedNotice } from "./parts";
import type { useFileTreeData } from "./useFileTreeData";

export interface FileTreeRowProps {
  node: FileNode;
  depth: number;
  /** 整棵树的统一额外左内边距（嵌套在工作区根之下时 > 0）。 */
  indentBase: number;
  source: FileSource;
  data: ReturnType<typeof useFileTreeData>;
  expanded: Set<string>;
  /** When non-null, only render children whose path is in the set. */
  filterVisible?: Set<string> | null;
  activePath: string | null;
  creating: { dir: string; kind: "file" | "dir" } | null;
  renaming: string | null;
  dropTarget: string | null;
  /** 当前键盘焦点行（高亮）。 */
  selectedPath: string | null;
  /** 已剪切待移动的行（半透明示意）。 */
  cutPath: string | null;
  /** 剪贴板非空（文件夹行据此显示「粘贴」）。 */
  hasClipboard: boolean;
  onToggle: (dir: string) => void;
  onOpenFile: (path: string, name: string) => void;
  onSelect: (node: FileNode) => void;
  onContextCreate: (dir: string, kind: "file" | "dir") => void;
  onStartRename: (path: string) => void;
  onSubmitRename: (path: string, name: string) => void;
  onCancelRename: () => void;
  onSubmitCreate: (name: string) => void;
  onCancelCreate: () => void;
  onDelete: (node: FileNode) => void;
  onCopy: (path: string) => void;
  onCut: (path: string) => void;
  onPaste: (destDir: string) => void;
  onMoveInto: (src: string, destDir: string) => void;
  onUpload: (files: FileList | null, destDir: string) => void;
  onDropTarget: (path: string | null) => void;
  /** Reload a directory after a mutation that adds siblings (e.g. export docx). */
  onReloadDir: (dir: string) => void;
}

export function FileTreeRow(props: FileTreeRowProps) {
  const { node, depth, source, data, expanded, dropTarget, indentBase } = props;
  const indent = depth * 14 + 8 + indentBase;
  const rowStyle = surfaceRowIndent(depth, indentBase);

  const startDrag = (e: React.DragEvent) => {
    const payload: DragPayload = { sourceId: source.id, path: node.path };
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };

  if (!node.isDir) {
    const isActive = props.activePath === node.path;
    const isSelected = props.selectedPath === node.path;
    const isCut = props.cutPath === node.path;
    return (
      <li>
        {props.renaming === node.path ? (
          <InlineRow
            indent={indent}
            icon={<FileTypeIcon name={node.name} size={13} />}
          >
            <InlineInput
              initial={node.name}
              onSubmit={(v) => props.onSubmitRename(node.path, v)}
              onCancel={props.onCancelRename}
            />
          </InlineRow>
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <SurfaceRow
                variant="file"
                active={isActive}
                selected={isSelected}
                cut={isCut}
                draggable
                onDragStart={startDrag}
                style={rowStyle}
              >
                <SimpleTooltip label={`预览 ${node.path}`}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      props.onSelect(node);
                      props.onOpenFile(node.path, node.name);
                    }}
                    className="h-auto min-w-0 flex-1 justify-start gap-1.5 overflow-hidden rounded-none px-0 py-1.5 text-left text-xs font-normal"
                  >
                    <FileTypeIcon name={node.name} size={13} />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    <FileRowMeta node={node} />
                  </Button>
                </SimpleTooltip>
              </SurfaceRow>
            </ContextMenuTrigger>
            <FileTreeRowMenu {...props} />
          </ContextMenu>
        )}
      </li>
    );
  }

  // Directory row.
  const open = expanded.has(node.path);
  const isTarget = dropTarget === node.path;
  const isSelected = props.selectedPath === node.path;
  const isCut = props.cutPath === node.path;
  const status = data.statusOf(node.path);
  const children = data.childrenOf(node.path);
  const stage = stageDirMeta(node.path);
  const stageCaption = stage
    ? stageDirCaption(stage, countDescendantFiles(node.path, data.childrenOf))
    : null;
  // 约定根改叫「AI 工作间」并退成次要行：与条目区（「记忆」）消歧，且它是过程材料。
  const isWorkroom = isAgentCoreRootDir(node.path);

  return (
    <li>
      {props.renaming === node.path ? (
        <InlineRow indent={indent} icon={null}>
          <InlineInput
            initial={node.name}
            onSubmit={(v) => props.onSubmitRename(node.path, v)}
            onCancel={props.onCancelRename}
          />
        </InlineRow>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <SurfaceRow
              variant="file"
              selected={isSelected}
              dropTarget={isTarget}
              cut={isCut}
              draggable
              onDragStart={startDrag}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(DRAG_MIME)) {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onDropTarget(node.path);
                } else if (source.caps.transfer) {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onDropTarget(node.path);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onDropTarget(null);
                const raw = e.dataTransfer.getData(DRAG_MIME);
                if (raw) {
                  const p = parseDragPayload(raw);
                  if (p && p.sourceId === source.id)
                    props.onMoveInto(p.path, node.path);
                  return;
                }
                if (source.caps.transfer && e.dataTransfer.files.length > 0)
                  props.onUpload(e.dataTransfer.files, node.path);
              }}
              style={rowStyle}
            >
              <SimpleTooltip
                label={
                  stage?.tooltip ??
                  (isWorkroom ? AGENTCORE_ROOT_TOOLTIP : node.path)
                }
              >
                <Button
                  variant="ghost"
                  onClick={() => {
                    props.onSelect(node);
                    props.onToggle(node.path);
                  }}
                  className={cn(
                    "h-auto min-w-0 flex-1 justify-start gap-1.5 overflow-hidden rounded-none px-0 py-1.5 text-left text-xs font-normal",
                    isWorkroom && "text-muted-foreground",
                  )}
                >
                  {open ? (
                    <ChevronDown
                      size={13}
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <ChevronRight
                      size={13}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {isWorkroom ? AGENTCORE_ROOT_LABEL : node.name}
                  </span>
                  {stageCaption && (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs leading-none ${statusPillSoft.muted}`}
                    >
                      {stageCaption}
                    </span>
                  )}
                  {/* 工作间行是刻意压低的次要行，不给它挂元信息。 */}
                  {!isWorkroom && <FileRowMeta node={node} />}
                </Button>
              </SimpleTooltip>
            </SurfaceRow>
          </ContextMenuTrigger>
          <FileTreeRowMenu {...props} />
        </ContextMenu>
      )}

      {open && (
        <ul>
          {props.creating?.dir === node.path && (
            <InlineCreateRow
              kind={props.creating.kind}
              depth={depth + 1}
              indentBase={indentBase}
              onSubmit={props.onSubmitCreate}
              onCancel={props.onCancelCreate}
            />
          )}
          {status === "loading" && children === undefined && (
            <li
              className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: (depth + 1) * 14 + 8 + indentBase }}
            >
              <Loader2 size={12} className="animate-spin" />
              加载中…
            </li>
          )}
          {status === "error" && (
            <li
              className="py-1 text-xs text-destructive/80"
              style={{ paddingLeft: (depth + 1) * 14 + 8 + indentBase }}
            >
              加载失败
            </li>
          )}
          {children?.length === 0 && !props.creating && (
            <li
              className="py-1 text-xs text-muted-foreground/60"
              style={{ paddingLeft: (depth + 1) * 14 + 8 + indentBase }}
            >
              空文件夹
            </li>
          )}
          {children
            ?.filter(
              (child) =>
                !props.filterVisible || props.filterVisible.has(child.path),
            )
            .map((child) => (
              <FileTreeRow
                key={child.path}
                {...props}
                node={child}
                depth={depth + 1}
              />
            ))}
          {data.truncatedOf(node.path) && (
            <TruncatedNotice
              indent={(depth + 1) * 14 + 8 + indentBase}
              shown={children?.length ?? 0}
            />
          )}
        </ul>
      )}
    </li>
  );
}
