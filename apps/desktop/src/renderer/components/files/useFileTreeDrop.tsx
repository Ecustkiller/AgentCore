import { getFolders } from "@/hooks/useFolders";
import type { FileSource } from "@/lib/fileSource";
import { baseName, joinPath, parentDir } from "@/lib/fileSource";
import type { DropUploadCapture } from "@/lib/folderUpload";
import { captureDropUpload } from "@/lib/folderUpload";
import { notifyActionError, notifyError } from "@/lib/toast";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { UploadReportDialog } from "./UploadReportDialog";
import { setFileClipboard } from "./fileClipboard";
import {
  type BatchFailure,
  type BatchOutcome,
  runBatch,
  withSkipped,
} from "./fileTreeBatch";
import { notifyFileTreeChanged } from "./fileTreeBus";
import { DRAG_MIME, type DragPayload, parseDragPayload } from "./fileTreeDrag";
import {
  CROSS_SOURCE_UNSUPPORTED,
  applyBridgedTransfer,
  resolveBridgedTransfer,
} from "./fileTreeTransfer";
import type { ClipboardEntry } from "./fileTreeTypes";
import type { FileTreeData } from "./useFileTreeData";
import { useFileUpload } from "./useFileUpload";

/**
 * {@link FileTree} 的「往里放东西」那一半：拖拽落点、上传入口、跨源搬运。
 *
 * 单独成 hook 是因为这三件事共用同一批判断（能不能写、落到哪一层、完事后谁要刷新），
 * 而它们又与树的选中/渲染完全无关——放一起只会让本就很大的 FileTree 更难同时被两个人改。
 *
 * 跨源：拖拽与粘贴都可能来自**另一棵**树（文件中枢把每个云文件夹渲染成独立源，父子亦然）。
 * 能接上的走 {@link resolveBridgedTransfer} 翻译成一次普通的工作区内 move/copy；接不上的
 * 明说 {@link CROSS_SOURCE_UNSUPPORTED}，不静默吞掉。搬完通知对面那棵树（它走 silent
 * 补丁）+ 摘掉它选区里已搬走的行（本树自己 reload，搬走了什么经 `onMoved` 回给调用方）。
 */
export function useFileTreeDrop({
  source,
  data,
  canMutate,
  revealDir,
  onDropTarget,
  reportBatch,
  reloadDirs,
  onMoved,
}: {
  source: FileSource;
  data: FileTreeData;
  /** `source.caps.edit`——只读源不接受任何落点。 */
  canMutate: boolean;
  /** 展开目标目录，让搬进去的东西立刻可见。 */
  revealDir: (dir: string) => void;
  /** 清/设高亮的目录行（拖到根上时清掉）。 */
  onDropTarget: (path: string | null) => void;
  /** 多项落地后的报账（与选区批量动作共用一套口径）。 */
  reportBatch: (verb: string, outcome: BatchOutcome) => void;
  /** 刷新受影响目录（急切源一次全树，惰性源逐目录）。 */
  reloadDirs: (dirs: Iterable<string>) => void;
  /** 本树里这几项已经搬走了——选区据此摘掉它们。 */
  onMoved: (paths: readonly string[]) => void;
}): {
  uploading: boolean;
  dragOver: boolean;
  /** 隐藏的两个 input（选文件 / 选文件夹）+ 上传结果详情弹窗。 */
  chrome: React.ReactNode;
  triggerUpload: () => void;
  triggerUploadFolder: () => void;
  /** 挂到树根容器上的拖拽属性（落到根 = 移出子目录 / 上传到根）。 */
  rootDragProps: Pick<
    React.HTMLAttributes<HTMLElement>,
    "onDragOver" | "onDragLeave" | "onDrop"
  >;
  /** 目录行的落点：同源走 `source.move`，异源走桥接。 */
  onMoveInto: (payload: DragPayload, destDir: string) => void;
  /** 目录行/根的上传落点（drop 事件里同步捕获的东西）。 */
  onUpload: (capture: DropUploadCapture, destDir: string) => void;
  /** 剪贴板来自别的树时的粘贴；逐项记账，由调用方按同一口径报账。 */
  pasteAcross: (clip: ClipboardEntry, destDir: string) => Promise<BatchOutcome>;
} {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // 稳定引用：这两个进 FileTree 的 useImperativeHandle 依赖，逐渲染新建会让外层 ref 抖。
  const triggerUpload = useCallback(() => fileInputRef.current?.click(), []);
  const triggerUploadFolder = useCallback(
    () => folderInputRef.current?.click(),
    [],
  );

  const reloadDir = useCallback((dir: string) => data.reload(dir), [data]);
  const { uploading, report, dismissReport, uploadFiles, uploadDropped } =
    useFileUpload(source, reloadDir);

  const canUpload = source.caps.transfer && canMutate;

  /** 同源移动：保名搬进 `destDir`，挡掉空操作与「搬进自己子树」。 */
  const moveWithin = useCallback(
    async (src: string, destDir: string) => {
      const dst = joinPath(destDir, baseName(src));
      if (dst === src) return;
      if (destDir === src || destDir.startsWith(`${src}/`)) return;
      try {
        await source.move(src, dst);
        data.reload(parentDir(src));
        data.reload(destDir);
        onMoved([src]);
      } catch {
        notifyError("目标位置已存在同名文件，或移动失败");
      }
    },
    [source, data, onMoved],
  );

  /**
   * 同源移动 N 项（拖的是整个选区）。没有批量端点，逐项调既有单项 move，故「部分成功」是
   * 常态：撞名的项不连累其余项，跳过与失败都逐项记账交给调用方一次报清。
   */
  const moveManyWithin = useCallback(
    async (
      paths: readonly string[],
      destDir: string,
    ): Promise<BatchOutcome> => {
      const skipped: BatchFailure[] = [];
      const pending: string[] = [];
      for (const src of paths) {
        if (destDir === src || destDir.startsWith(`${src}/`)) {
          skipped.push({
            path: src,
            name: baseName(src),
            reason: "不能移动到自身或其子目录",
          });
          continue;
        }
        if (parentDir(src) === destDir) continue; // 原地：空操作
        pending.push(src);
      }
      const outcome = await runBatch(pending, (src) =>
        source.move(src, joinPath(destDir, baseName(src))),
      );
      reloadDirs([destDir, ...pending.map(parentDir)]);
      const failed = new Set(outcome.failures.map((f) => f.path));
      onMoved(pending.filter((p) => !failed.has(p)));
      return withSkipped(skipped, outcome);
    },
    [source, reloadDirs, onMoved],
  );

  /**
   * 跨源搬运一项。接不上时抛 {@link CROSS_SOURCE_UNSUPPORTED}——调用方要么当单项失败报
   * 出来，要么记进批量账本，两条路都会把这句原样呈给用户。
   */
  const transferAcross = useCallback(
    async (
      from: { sourceId: string; path: string },
      destDir: string,
      op: "move" | "copy",
    ): Promise<void> => {
      const bridged = resolveBridgedTransfer(
        from,
        { sourceId: source.id, dir: destDir },
        getFolders(),
      );
      if (!bridged) throw new Error(CROSS_SOURCE_UNSUPPORTED);
      await applyBridgedTransfer(bridged, op);
      // 移动会让**对面**那棵树少一项，而它自己不会知道（复制不动源，无需惊动）：既要重拉
      // 那一层，也要把它选区里这一行摘掉——否则那边的下一次删除对着已搬走的路径开火。
      if (op === "move") {
        notifyFileTreeChanged({
          sourceId: from.sourceId,
          dir: parentDir(from.path),
          movedAway: [from.path],
        });
      }
      revealDir(destDir);
      data.reload(destDir);
    },
    [source.id, data, revealDir],
  );

  const onMoveInto = useCallback(
    (payload: DragPayload, destDir: string) => {
      if (!canMutate) return;
      const { sourceId, paths } = payload;
      if (paths.length === 0) return;
      const within = sourceId === source.id;
      // 单项保持原样：搬成了树自己会变，不必再说一句；搬不动才一条 toast。
      if (paths.length === 1) {
        const path = paths[0];
        if (within) {
          void moveWithin(path, destDir);
          return;
        }
        void (async () => {
          try {
            await transferAcross({ sourceId, path }, destDir, "move");
          } catch (e) {
            notifyActionError("移动失败", e);
          }
        })();
        return;
      }
      // 拖的是整个选区：逐项调单项端点，部分成功是常态，按与批量删除同一套口径报账。
      void (async () => {
        const outcome = within
          ? await moveManyWithin(paths, destDir)
          : await runBatch(paths, (path) =>
              transferAcross({ sourceId, path }, destDir, "move"),
            );
        reportBatch("移动", outcome);
      })();
    },
    [
      canMutate,
      source.id,
      moveWithin,
      moveManyWithin,
      transferAcross,
      reportBatch,
    ],
  );

  const pasteAcross = useCallback(
    async (clip: ClipboardEntry, destDir: string): Promise<BatchOutcome> => {
      const op = clip.op === "cut" ? "move" : "copy";
      const outcome = await runBatch(clip.paths, (path) =>
        transferAcross({ sourceId: clip.sourceId, path }, destDir, op),
      );
      // 剪切一次性；复制留着可重复粘贴。整批都没成时保住剪贴板，用户还能换个地方粘。
      if (clip.op === "cut" && outcome.done > 0) setFileClipboard(null);
      return outcome;
    },
    [transferAcross],
  );

  const onUpload = useCallback(
    (capture: DropUploadCapture, destDir: string) => {
      if (!canUpload) return;
      uploadDropped(capture, destDir);
    },
    [canUpload, uploadDropped],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_MIME)) {
        onDropTarget(null);
        // 内部拖拽也要 preventDefault，否则根区收不到 drop——「从子目录拖回根」
        // 与「从别的树拖到这棵树的空白处」都靠这一句才成立。
        if (canMutate) e.preventDefault();
        return;
      }
      if (canUpload) {
        e.preventDefault();
        setDragOver(true);
      }
    },
    [canMutate, canUpload, onDropTarget],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      setDragOver(false);
      onDropTarget(null);
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (raw) {
        e.preventDefault();
        const payload = parseDragPayload(raw);
        if (payload) onMoveInto(payload, "");
        return;
      }
      if (!canUpload) return;
      const capture = captureDropUpload(e.dataTransfer);
      if (capture.entries.length === 0 && capture.looseFiles.length === 0) {
        return;
      }
      e.preventDefault();
      uploadDropped(capture, "");
    },
    [canUpload, onMoveInto, onDropTarget, uploadDropped],
  );

  return {
    uploading,
    dragOver,
    chrome: canUpload ? (
      <>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            uploadFiles(e.target.files, "");
            e.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="上传文件夹"
          // Chromium 的目录选择开关；React 的 input 类型里没有这两个属性。
          {...({ webkitdirectory: "", directory: "" } as Record<
            string,
            string
          >)}
          onChange={(e) => {
            uploadFiles(e.target.files, "");
            e.target.value = "";
          }}
        />
        <UploadReportDialog report={report} onClose={dismissReport} />
      </>
    ) : null,
    triggerUpload,
    triggerUploadFolder,
    rootDragProps: {
      onDragOver,
      onDragLeave: () => setDragOver(false),
      onDrop,
    },
    onMoveInto,
    onUpload,
    pasteAcross,
  };
}
