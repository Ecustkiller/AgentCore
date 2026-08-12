import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hasAutoUpdater } from "@/lib/capabilities";
import { clientVersion } from "@/lib/clientBuildInfo";
import { formatBytes, formatDownloadProgress } from "@/lib/format";
import {
  clientReleaseChannel,
  desktopDownloadUrlForChannel,
} from "@/lib/releaseChannel";
import {
  UPDATE_NOTES_FALLBACK,
  isForceUpdateActive,
  useUpdatesStore,
} from "@/stores/updates";
import { Loader2 } from "lucide-react";

/**
 * Consent-first update explanation dialog (发布与门禁.md §7.6).
 *
 * Soft update: only the `available` consent surface — 「立即更新」关窗并后台静默下载。
 * `autoInstallCapable === false`：不调 download，主行动改为打开本通道下载页。
 * Force-update hard gate: non-dismissible multi-phase (download progress / install /
 * retry) when the dialog is opened from the gate. Force 态任意 phase 都保留下载页出口。
 */
export function UpdateAvailableDialog() {
  const dialogOpen = useUpdatesStore((s) => s.dialogOpen);
  const status = useUpdatesStore((s) => s.status);
  const outdatedMinVersion = useUpdatesStore((s) => s.outdatedMinVersion);
  const closeUpdateDialog = useUpdatesStore((s) => s.closeUpdateDialog);
  const download = useUpdatesStore((s) => s.download);
  const remindLater = useUpdatesStore((s) => s.remindLater);
  const skipVersion = useUpdatesStore((s) => s.skipVersion);
  const install = useUpdatesStore((s) => s.install);

  if (!hasAutoUpdater()) return null;

  const force = isForceUpdateActive({ outdatedMinVersion });
  const manualOnly = !status.autoInstallCapable;

  const version =
    status.phase === "available" ||
    status.phase === "downloading" ||
    status.phase === "downloaded"
      ? status.version
      : null;

  // Soft: consent only. Force: keep download / ready / error in-dialog.
  const relevant = force
    ? status.phase === "available" ||
      status.phase === "downloading" ||
      status.phase === "downloaded" ||
      status.phase === "error"
    : status.phase === "available";

  const open = dialogOpen && relevant;

  const releaseNotes =
    status.phase === "available"
      ? status.releaseNotes?.trim() || UPDATE_NOTES_FALLBACK
      : UPDATE_NOTES_FALLBACK;

  const sizeBytes =
    status.phase === "available" ? (status.sizeBytes ?? null) : null;

  const downloadPageUrl = desktopDownloadUrlForChannel(clientReleaseChannel());

  const current = clientVersion();
  const title =
    status.phase === "downloaded"
      ? `新版本 ${version} 已就绪`
      : status.phase === "downloading"
        ? `正在下载 ${version}`
        : status.phase === "error"
          ? "更新失败"
          : `发现新版本 ${version ?? ""}`;

  const downloadPageLink = (
    <a
      href={downloadPageUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
    >
      前往下载页
    </a>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !force) closeUpdateDialog();
      }}
    >
      {relevant ? (
        <DialogContent
          className="flex max-h-[min(80vh,32rem)] max-w-md flex-col gap-0 p-0"
          showClose={!force}
          onEscapeKeyDown={(e) => {
            if (force) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (force) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (force) e.preventDefault();
          }}
        >
          <DialogHeader className={force ? undefined : "pr-10"}>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>

          <DialogDescription asChild>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-2">
              {status.phase === "available" ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    当前版本 {current}
                    {sizeBytes != null && sizeBytes > 0
                      ? ` · 安装包约 ${formatBytes(sizeBytes)}`
                      : null}
                  </p>
                  {manualOnly ? (
                    <p className="text-sm text-muted-foreground">
                      此版本需手动下载安装。请前往下载页获取安装包并完成安装。
                    </p>
                  ) : null}
                  <p className="whitespace-pre-wrap text-sm text-foreground">
                    {releaseNotes}
                  </p>
                </>
              ) : null}

              {force && status.phase === "downloading" ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    下载进度{" "}
                    {formatDownloadProgress({
                      percent: status.percent,
                      transferred: status.transferred,
                      total: status.total,
                      bytesPerSecond: status.bytesPerSecond,
                    })}
                  </p>
                  <progress
                    className="h-2 w-full overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
                    value={Math.min(100, status.percent)}
                    max={100}
                  />
                </div>
              ) : null}

              {force && status.phase === "downloaded" ? (
                <p className="text-sm text-muted-foreground">
                  将在重启后安装。
                </p>
              ) : null}

              {force && status.phase === "error" ? (
                <p className="text-sm text-destructive">{status.message}</p>
              ) : null}
            </div>
          </DialogDescription>

          <DialogFooter>
            {status.phase === "available" ? (
              <>
                {force ? null : (
                  <>
                    <Button
                      variant="ghost"
                      size="md"
                      onClick={() => skipVersion()}
                    >
                      跳过此版本
                    </Button>
                    <Button
                      variant="neutral"
                      size="md"
                      onClick={() => remindLater()}
                    >
                      稍后提醒
                    </Button>
                  </>
                )}
                {manualOnly ? (
                  downloadPageLink
                ) : (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => void download()}
                  >
                    立即更新
                  </Button>
                )}
              </>
            ) : null}

            {force && status.phase === "downloading" ? (
              <>
                <Button
                  variant="neutral"
                  size="md"
                  disabled
                  icon={<Loader2 size={14} className="animate-spin" />}
                >
                  下载中…
                </Button>
                <a
                  href={downloadPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium text-foreground underline-offset-2 hover:underline"
                >
                  前往下载页手动安装
                </a>
              </>
            ) : null}

            {force && status.phase === "downloaded" ? (
              <Button
                variant="primary"
                size="md"
                onClick={() => void install()}
              >
                重启安装
              </Button>
            ) : null}

            {force && status.phase === "error" ? (
              manualOnly ? (
                downloadPageLink
              ) : (
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => void download()}
                >
                  重试下载
                </Button>
              )
            ) : null}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
