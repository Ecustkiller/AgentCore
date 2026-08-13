import { ConfirmDialog } from "@/components/ui";
import { isFeatureUnavailable } from "@/lib/errors";
import { type DocumentNode, getDocument } from "@/services/documents";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { parseEntryMemoryLines } from "./entryMemoryLines";

/**
 * Confirm「这条不对」before it lands (纠错通道 · Agent记忆与知识系统).
 *
 * The mark is entry-level, but the user arrives here from a「记忆已更新」card that listed
 * **one sentence** — so the click they are about to make silently takes every other line
 * in the same entry with it. This dialog exists to close that gap: it reads the entry's
 * body and names the lines that stop being used, so the choice is「误伤还是放弃」no more.
 *
 * The per-line cut is not offered here but on the「记忆已更新」card itself, where the user
 * is looking straight at the sentence ({@link MemoryUpdateItemRow}); this dialog covers the
 * other route in, from the file. When there IS collateral, it points at that smaller knife
 * — the whole reason this dialog exists is the user who only meant to reject one line.
 *
 * Copy stays on the 停用 side of the 定案: the entry leaves injection and the always pool,
 * the text stays readable and the mark is undoable. Never「删除」.
 */
export function DisputeEntryDialog({
  doc,
  busy,
  onOpenChange,
  onConfirm,
}: {
  /** The entry about to be disputed; null keeps the dialog closed. */
  doc: DocumentNode | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const body = useQuery({
    queryKey: ["document-body", doc?.id],
    queryFn: () => getDocument(doc?.id ?? ""),
    enabled: doc != null,
    staleTime: 15_000,
    retry: (failureCount, error) =>
      !isFeatureUnavailable(error) && failureCount < 2,
  });

  const lines = body.data ? parseEntryMemoryLines(body.data.content) : [];
  const consequence =
    doc?.applyMode === "always"
      ? "停用后 AI 每次对话不再带上它，也不再占用常驻额度。"
      : "停用后 AI 需要时也不会再查阅它。";

  return (
    <ConfirmDialog
      open={doc != null}
      onOpenChange={onOpenChange}
      title={`停用整个「${doc?.name ?? ""}」？`}
      description="「这条不对」标在整个条目上，不是其中某一句。"
      confirmLabel="停用整个条目"
      busy={busy}
      onConfirm={onConfirm}
    >
      <div className="space-y-2 text-sm">
        {body.isPending ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 size={13} className="animate-spin" />
            正在看这个条目里有哪几条…
          </p>
        ) : body.isError ? (
          // Honest about the gap rather than printing a count we could not read:
          // the mark still lands on the whole entry either way.
          <p className="text-muted-foreground">
            读不到条目内容，列不出会被一起停用的是哪几条；停用仍然落在整个条目上。
          </p>
        ) : lines.length > 0 ? (
          <>
            <p className="text-foreground">
              {/* An entry holding a single line has no collateral — say so rather
                  than dressing it up as one, or the warning stops being read. */}
              {lines.length === 1
                ? "里面只有这 1 条，停用它就是停用整个条目："
                : `里面这 ${lines.length} 条会一起停用：`}
            </p>
            {/* Scrolls instead of truncating: 「哪几条」answered with「…还有 N 条」
                would put the user back where they started. */}
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-muted/50 px-2.5 py-2">
              {lines.map((line, i) => (
                <li
                  key={`${line.section ?? ""}:${line.text}:${i}`}
                  className="flex gap-1.5 text-sm leading-snug"
                >
                  <span aria-hidden className="shrink-0 text-muted-foreground">
                    ·
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    {line.section ? (
                      <span className="text-muted-foreground">
                        {line.section}&nbsp;·&nbsp;
                      </span>
                    ) : null}
                    <span>{line.text}</span>
                  </span>
                </li>
              ))}
            </ul>
            {lines.length > 1 && (
              <p className="text-xs text-muted-foreground">
                只想否掉其中一条？在「记忆已更新」卡片里点那一行的「这条不对」，只有那句会被移走。
              </p>
            )}
          </>
        ) : (
          <p className="text-foreground">这个条目的全部内容都会停用。</p>
        )}
        <p className="text-xs text-muted-foreground">
          {consequence}内容保留在这里，随时可以右键「恢复使用」——不是删除。
        </p>
      </div>
    </ConfirmDialog>
  );
}
