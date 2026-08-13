/**
 * Background「导入到云」job：关窗后仍跑；同一 id 可更新 toast + 可取消。
 *
 * 终态必须显式覆盖 `action` / `duration`：sonner 同 id 浅合并，省略字段会残留
 * 进行中的「取消」与 `Infinity`（粘住不自动关）。
 */
import {
  ImportToCloudCancelledError,
  type ImportToCloudProgress,
  type ImportToCloudResult,
  formatImportToCloudCancelledToast,
  formatImportToCloudProgress,
  formatImportToCloudToast,
  runImportToCloud,
} from "@/lib/importToCloud";
import { openDraftConversation } from "@/lib/newConversation";
import { queryClient } from "@/lib/queryClient";
import { workspaceKeys } from "@/lib/queryKeys";
import { notifyInfo } from "@/lib/toast";
import { useImportToCloudJobStore } from "@/stores/importToCloudJob";
import type { FsRoot } from "@shared/ipc-contract";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { createElement } from "react";
import { toast } from "sonner";

const TOAST_ID = "import-to-cloud";

/** 完整成功：短提示 + 可点「打开」。 */
const SUCCESS_TOAST_MS = 5_000;
/** 部分导入 / 失败 / 已建云取消：稍长，便于读说明或点「打开」。 */
const EXTENDED_TOAST_MS = 8_000;
/** 未建云即取消：短提示即关。 */
const CANCELLED_PLAIN_TOAST_MS = 3_000;

function openProjectToastAction(folderId: string): {
  label: string;
  onClick: () => void;
} {
  return {
    label: "打开",
    // 显式再带 folderId 开草稿，避免与 runImportToCloud 的 intent 写入竞态。
    onClick: () => openDraftConversation(folderId),
  };
}

/** 无主 CTA 的终态：显式清掉进度 toast 的「取消」。 */
const CLEAR_ACTION = { action: undefined as undefined };

const loadingIcon = createElement(Loader2, {
  size: 16,
  className: "animate-spin text-primary",
});
const successIcon = createElement(CheckCircle2, {
  size: 16,
  className: "text-success",
});
const warningIcon = createElement(AlertTriangle, {
  size: 16,
  className: "text-muted-foreground",
});
const errorIcon = createElement(AlertTriangle, {
  size: 16,
  className: "text-destructive",
});

export type StartImportToCloudJobOpts = {
  root: FsRoot;
  /** Dialog-owned temp root → true; prefill shared binding → false. */
  ownsRoot: boolean;
  folderName: string;
  onImported?: (folderId: string) => void;
};

function showProgressToast(p: ImportToCloudProgress): void {
  toast(formatImportToCloudProgress(p) || "正在导入到「我的文件」…", {
    id: TOAST_ID,
    duration: Number.POSITIVE_INFINITY,
    icon: loadingIcon,
    action: {
      label: "取消",
      onClick: () => useImportToCloudJobStore.getState().cancel(),
    },
  });
}

function successDuration(result: ImportToCloudResult): number {
  return result.partial ? EXTENDED_TOAST_MS : SUCCESS_TOAST_MS;
}

/**
 * Start background import. Returns false (and tips) when a job is already running.
 * Does not bind to Dialog lifecycle.
 */
export function startImportToCloudJob(
  opts: StartImportToCloudJobOpts,
): boolean {
  const store = useImportToCloudJobStore.getState();
  if (store.isRunning()) {
    notifyInfo("已有导入正在进行", {
      description: "请等待当前导入完成，或在进度提示中取消后再试",
    });
    return false;
  }

  const controller = new AbortController();
  if (!store.begin(controller)) {
    notifyInfo("已有导入正在进行", {
      description: "请等待当前导入完成，或在进度提示中取消后再试",
    });
    return false;
  }

  showProgressToast({ phase: "archiving" });

  void (async () => {
    try {
      const result = await runImportToCloud({
        root: opts.root,
        ownsRoot: opts.ownsRoot,
        folderName: opts.folderName,
        signal: controller.signal,
        onProgress: showProgressToast,
      });
      const done = formatImportToCloudToast(result);
      toast.success(done.message, {
        id: TOAST_ID,
        description: done.description,
        icon: successIcon,
        duration: successDuration(result),
        action: openProjectToastAction(result.folderId),
      });
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
      opts.onImported?.(result.folderId);
    } catch (e) {
      if (e instanceof ImportToCloudCancelledError) {
        const cancelled = formatImportToCloudCancelledToast(e);
        if (e.folderId) {
          toast.warning(cancelled.message, {
            id: TOAST_ID,
            description: cancelled.description,
            icon: warningIcon,
            duration: EXTENDED_TOAST_MS,
            action: openProjectToastAction(e.folderId),
          });
          void queryClient.invalidateQueries({ queryKey: workspaceKeys.list });
          opts.onImported?.(e.folderId);
        } else {
          toast(cancelled.message, {
            id: TOAST_ID,
            icon: warningIcon,
            duration: CANCELLED_PLAIN_TOAST_MS,
            ...CLEAR_ACTION,
          });
        }
        return;
      }
      const detail =
        e instanceof Error ? e.message : typeof e === "string" ? e : "";
      toast.error("导入到「我的文件」失败", {
        id: TOAST_ID,
        description: detail || undefined,
        icon: errorIcon,
        duration: EXTENDED_TOAST_MS,
        ...CLEAR_ACTION,
      });
    } finally {
      useImportToCloudJobStore.getState().end(controller);
    }
  })();

  return true;
}

export function isImportToCloudJobRunning(): boolean {
  return useImportToCloudJobStore.getState().isRunning();
}

export function cancelImportToCloudJob(): void {
  useImportToCloudJobStore.getState().cancel();
}
