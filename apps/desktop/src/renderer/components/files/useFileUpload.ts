import type { FileSource } from "@/lib/fileSource";
import {
  type DropUploadCapture,
  type PickedUpload,
  type UploadReport,
  collectPickedFiles,
  describeUploadReport,
  expandDropUpload,
  uploadPicked,
} from "@/lib/folderUpload";
import { notifyActionError, notifySuccess, notifyWarning } from "@/lib/toast";
import { useCallback, useState } from "react";

/**
 * 上传（单文件 / 多文件 / 整个文件夹）的状态与收尾报告，从 {@link FileTree} 里拆出来。
 *
 * 收尾一律走 {@link describeUploadReport}：一切顺利报一条成功；只要有超限、失败或被忽略
 * 的项，就退成警告并挂「查看详情」——逐项清单由 {@link UploadReportDialog} 展示。
 *
 * `onUploaded` 须是**稳定引用**（`useCallback`），否则每次渲染都会重建这里的回调。
 */
export function useFileUpload(
  source: FileSource,
  onUploaded: (destDir: string) => void,
): {
  uploading: boolean;
  report: UploadReport | null;
  dismissReport: () => void;
  /** 来自 `<input type="file">`（含 `webkitdirectory`）的选择。 */
  uploadFiles: (list: FileList | null, destDir: string) => void;
  /** 来自 drop 事件的同步捕获（见 {@link captureDropUpload}）。 */
  uploadDropped: (capture: DropUploadCapture, destDir: string) => void;
} {
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<UploadReport | null>(null);

  const start = useCallback(
    (load: () => PickedUpload | Promise<PickedUpload>, destDir: string) => {
      void (async () => {
        setUploading(true);
        try {
          const picked = await load();
          // 只有目录也得往下走：空文件夹全靠 mkdir 落地，在这里返回等于把用户
          // 拖进来的那棵树静默吞掉。
          if (
            picked.files.length === 0 &&
            picked.dirs.length === 0 &&
            picked.ignored.length === 0 &&
            !picked.truncated
          ) {
            return;
          }
          const result = await uploadPicked(picked, destDir, source);
          onUploaded(destDir);
          const { message, description, hasDetail } =
            describeUploadReport(result);
          if (hasDetail) {
            notifyWarning(message, {
              description,
              action: { label: "查看详情", onClick: () => setReport(result) },
            });
          } else {
            notifySuccess(message);
          }
        } catch (e) {
          notifyActionError("上传失败", e);
        } finally {
          setUploading(false);
        }
      })();
    },
    [source, onUploaded],
  );

  return {
    uploading,
    report,
    dismissReport: useCallback(() => setReport(null), []),
    uploadFiles: useCallback(
      (list: FileList | null, destDir: string) =>
        start(() => collectPickedFiles(list), destDir),
      [start],
    ),
    uploadDropped: useCallback(
      (capture: DropUploadCapture, destDir: string) =>
        start(() => expandDropUpload(capture), destDir),
      [start],
    ),
  };
}
