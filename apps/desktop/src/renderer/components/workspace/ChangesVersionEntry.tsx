import { IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type {
  VersionSource,
  VersionTimelineEntry,
} from "@/components/workspace/changesTimeline";
import { formatBytes, formatMessageTime } from "@/lib/format";
import { notifyActionError, notifyError } from "@/lib/toast";
import {
  deleteLocalVersion,
  restoreLocalVersion,
} from "@/services/localWorkspaceVersions";
import { downloadSnapshot, restoreSnapshot } from "@/services/workspace";
import { wsDownloadSnapshot, wsRestoreSnapshot } from "@/services/workspaces";
import {
  Archive,
  Bookmark,
  Download,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useState } from "react";

/**
 * 时间轴上的一条版本条目 —— 用户留存版本 / 交接存档，云端与本机同一张卡。
 * 留存版本是用户自己打的锚点，不能被回合流淹没：书签图标 + 品牌描边压住回合卡的中性壳。
 *
 * 只有动作按 {@link VersionSource} 分叉，且分叉来自能力而非设计口味：云端有 download API
 * 没有 delete API；本机反过来——版本躺在用户自己的盘上（无需下载），且**永不自动清理**，
 * 没有删除入口就是磁盘永久堆积。
 */

/** 恢复的能力边界（overlay 覆盖，不是完整镜像）——云端本机同一口径，与回合基线回滚一致。 */
const restoreHint = (what: string) =>
  `尽最大努力回到${what}（overlay 覆盖同名文件；此后新建的文件不会被删除，未进包的目录如 node_modules/.venv 等也不会还原）`;

/** 版本按工作区存储键组织，项目下各会话共用一份历史——不是 bug，说清即可。 */
const SHARED_HINT =
  "版本存在项目工作区里：同项目的其他会话也看得到、也能恢复。";

const DELETE_HINT =
  "删除这个版本（不可恢复）。本机命名版本永不自动清理，只有删了才释放磁盘；当前工作区文件不受影响。";

export function ChangesVersionEntry({
  source,
  entry,
  shared,
  onChanged,
}: {
  source: VersionSource;
  entry: VersionTimelineEntry;
  /** 工作区属于某个项目（`folder:*`）时，版本对兄弟会话可见。 */
  shared: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"download" | "restore" | "delete" | null>(
    null,
  );
  const isVersion = entry.kind === "version";
  const isLocal = source.origin === "local";
  const what = isVersion ? "这个版本" : "这份存档";

  const onDownload = async () => {
    if (busy || isLocal) return;
    setBusy("download");
    try {
      if (source.origin === "cloudWs") {
        await wsDownloadSnapshot(source.wsId, entry.id);
      } else {
        await downloadSnapshot(source.conversationId, entry.id);
      }
    } catch (e) {
      notifyActionError("下载失败", e);
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    if (busy) return;
    if (!window.confirm(`${restoreHint(what)}。确定继续？`)) return;
    setBusy("restore");
    try {
      if (source.origin === "local") {
        await restoreLocalVersion(source.target, entry.id);
      } else if (source.origin === "cloudWs") {
        await wsRestoreSnapshot(source.wsId, entry.id);
      } else {
        await restoreSnapshot(source.conversationId, entry.id);
      }
      onChanged();
    } catch (e) {
      notifyError(e, "恢复失败");
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    if (busy || source.origin !== "local") return;
    if (!window.confirm(`删除「${entry.title}」后不可恢复。确定删除？`)) return;
    setBusy("delete");
    try {
      await deleteLocalVersion(source.target, entry.id);
      onChanged();
    } catch (e) {
      notifyError(e, "删除版本失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      data-testid="changes-timeline-entry"
      data-entry-kind={entry.kind}
      data-entry-id={entry.id}
      className={`rounded-xl border ${
        isVersion ? "border-primary/40 bg-primary/5" : "border-border bg-card"
      }`}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        {isVersion ? (
          <Bookmark size={13} className="shrink-0 text-primary" />
        ) : (
          <Archive size={13} className="shrink-0 text-muted-foreground" />
        )}
        <h3
          className={`min-w-0 flex-1 truncate text-xs font-medium ${
            isVersion ? "text-foreground" : "text-muted-foreground"
          }`}
          title={entry.rawLabel ?? entry.title}
        >
          {entry.title}
        </h3>
        {isLocal ? null : (
          <SimpleTooltip label={`下载${what} (zip)`}>
            <IconButton
              disabled={busy === "download"}
              onClick={() => void onDownload()}
              aria-label={`下载${what} (zip)`}
            >
              {busy === "download" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
            </IconButton>
          </SimpleTooltip>
        )}
        {/* 短 aria-label + 长诚实 tooltip：能力边界要说清，但别塞进无障碍名字。 */}
        <SimpleTooltip label={restoreHint(what)}>
          <IconButton
            disabled={busy === "restore"}
            onClick={() => void onRestore()}
            aria-label={`恢复到${what}`}
          >
            {busy === "restore" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RotateCcw size={13} />
            )}
          </IconButton>
        </SimpleTooltip>
        {isLocal ? (
          <SimpleTooltip label={DELETE_HINT}>
            <IconButton
              disabled={busy === "delete"}
              onClick={() => void onDelete()}
              aria-label={`删除${what}`}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              {busy === "delete" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )}
            </IconButton>
          </SimpleTooltip>
        ) : null}
      </header>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-xs text-muted-foreground">
        <span>{isVersion ? "留存版本" : "交接存档"}</span>
        <span>·</span>
        <span>{formatMessageTime(entry.at)}</span>
        <span>·</span>
        <span>{formatBytes(entry.sizeBytes)}</span>
        {isVersion && shared ? (
          <>
            <span>·</span>
            <SimpleTooltip label={SHARED_HINT}>
              <span className="underline decoration-dotted underline-offset-2">
                本项目共享
              </span>
            </SimpleTooltip>
          </>
        ) : null}
      </div>
    </section>
  );
}
