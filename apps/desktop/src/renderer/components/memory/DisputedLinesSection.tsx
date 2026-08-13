import { formatMemoryTime } from "@/components/memory/MemoryUpdateItemRow";
import { ConfirmDialog } from "@/components/ui";
import { notifyActionError, notifyInfo } from "@/lib/toast";
import { ApiError } from "@/services/api";
import {
  MEMORY_DISPUTED_LINES_KEY,
  type MemoryDisputedLine,
  clearDisputedMemoryLines,
  listDisputedMemoryLines,
  restoreMemoryLine,
} from "@/services/memory";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * 已移走的记忆 — the recovery surface for line-level rejections (纠错通道·行级).
 *
 * A rejected line is REMOVED from its entry body (that is what stops it being injected), so
 * unlike the entry-level channel — which keeps the file readable and just skips it — there
 * is nowhere else the text still exists for the user to see. Without this list「可撤销」
 * would only be true for as long as the toast is on screen. Collapsed by default: this is a
 * recovery path, not something to stare at.
 *
 * The list is bounded (`maxPerEntry`, stated in the UI rather than left to surprise) and can
 * be emptied on purpose: the channel's own honest boundary is that the AI may re-learn a
 * rejected fact and the user rejects it again, a loop with no natural end, so its record
 * needs both an upper bound and a way out for someone who will never restore any of it.
 *
 * Renders nothing when there is nothing rejected, so the memory view is unchanged for
 * everyone who never used the feature.
 */
export function DisputedLinesSection() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const disputed = useQuery({
    queryKey: MEMORY_DISPUTED_LINES_KEY,
    queryFn: () => listDisputedMemoryLines(),
    staleTime: 30_000,
  });

  const lines = disputed.data?.lines ?? [];
  if (lines.length === 0) return null;

  const restore = async (line: MemoryDisputedLine) => {
    if (busy) return;
    setBusy(true);
    try {
      await restoreMemoryLine({
        id: line.id,
        kind: line.kind,
        topicSlug: line.topicSlug,
        folderId: line.folderId,
      });
      notifyInfo("已放回这条记忆");
      await disputed.refetch();
    } catch (e) {
      notifyActionError(
        "恢复失败",
        e instanceof ApiError ? (e.serverMessage ?? e.message) : e,
      );
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await clearDisputedMemoryLines();
      setConfirmClear(false);
      notifyInfo("已清空", {
        description: "这些内容不再能放回；被否掉的那几句本来就已经不在记忆里了",
      });
      await disputed.refetch();
    } catch (e) {
      notifyActionError(
        "清空失败",
        e instanceof ApiError ? (e.serverMessage ?? e.message) : e,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card/40 p-3">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left"
        >
          {open ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="text-xs font-medium text-muted-foreground">
            已移走的记忆
          </span>
          <span className="text-xs text-muted-foreground">
            {lines.length} 条
          </span>
        </button>
        {busy && (
          <Loader2
            size={12}
            className="shrink-0 animate-spin text-muted-foreground"
          />
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmClear(true)}
          className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline disabled:opacity-50"
        >
          清空
        </button>
      </div>
      {open && (
        <>
          <ul className="mt-1.5 space-y-0.5">
            {lines.map((line) => (
              <li
                key={line.id}
                className="flex items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground line-through">
                    {line.text}
                  </p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {line.section && (
                      <span className="truncate">{line.section}</span>
                    )}
                    {line.disputedAt && (
                      <span>{formatMemoryTime(line.disputedAt)}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void restore(line)}
                  className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  放回
                </button>
              </li>
            ))}
          </ul>
          {/* Say the bound out loud — an entry quietly dropping its oldest record would
              make「可撤销」a promise that expires without telling anyone. */}
          <p className="mt-1.5 px-1.5 text-xs text-muted-foreground">
            每个条目最多保留最近 {disputed.data?.maxPerEntry ?? 0}{" "}
            条，更早的不再能放回。
          </p>
        </>
      )}
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空「已移走的记忆」？"
        description={`这 ${lines.length} 条将不再能放回。`}
        confirmLabel="清空"
        tone="danger"
        busy={busy}
        onConfirm={() => void clearAll()}
      >
        <p className="text-sm text-muted-foreground">
          被否掉的那几句本来就已经不在记忆里了，清空去掉的只是「放回」这个出口。
        </p>
      </ConfirmDialog>
    </section>
  );
}
