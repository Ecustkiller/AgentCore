import { CanvasShell } from "@/components/layout/CanvasShell";
import { Button, Textarea } from "@/components/ui";
import { isWebPreview } from "@/lib/preview";
import { notifyError } from "@/lib/toast";
import { sendTableTurn } from "@/services/tableTurn";
import { getTable, renameTable as renameTableRemote } from "@/services/tables";
import { TableEditor, useTablesStore } from "@/tables";
import { downloadCsv } from "@/tables/csv";
import { installTablesRemote } from "@/tables/remote";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

export function TableEditorPage() {
  const { tableId = "" } = useParams();
  const navigate = useNavigate();
  const preview = isWebPreview();
  const table = useTablesStore((s) => s.tables.find((t) => t.id === tableId));
  const renameLocal = useTablesStore((s) => s.renameTable);
  const replaceTable = useTablesStore((s) => s.replaceTable);
  const [title, setTitle] = useState(table?.title ?? "");
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(!preview);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(
    table?.conversationId ?? null,
  );
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;

  const onSelectionChange = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) {
        return prev;
      }
      return ids;
    });
  }, []);

  const reload = useCallback(async () => {
    if (preview || !tableId) return;
    const next = await getTable(tableId);
    replaceTable(next);
  }, [preview, replaceTable, tableId]);

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    getTable(tableId)
      .then((doc) => {
        if (cancelled) return;
        replaceTable(doc);
        setTitle(doc.title);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [preview, replaceTable, tableId]);

  useEffect(() => {
    if (preview) return;
    return installTablesRemote(tableId);
  }, [preview, tableId]);

  useEffect(() => {
    if (table?.title) setTitle(table.title);
  }, [table?.title]);

  useEffect(() => {
    if (table?.conversationId) setConversationId(table.conversationId);
  }, [table?.conversationId]);

  const commitTitle = useCallback(() => {
    if (!table) return;
    const next = title.trim();
    if (!next || next === table.title) {
      setTitle(table.title);
      return;
    }
    renameLocal(table.id, next);
    if (!preview) {
      void renameTableRemote(table.id, next).catch((err) => {
        notifyError(err, "重命名失败");
        void reload();
      });
    }
  }, [preview, reload, renameLocal, table, title]);

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending || preview) return;
    const snapshot = [...selectedRef.current];
    setDraft("");
    setSending(true);
    try {
      await sendTableTurn(tableId, content, {
        tableSelection: snapshot,
        onConversation: setConversationId,
      });
      await reload();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      notifyError(err, "发送失败");
    } finally {
      setSending(false);
    }
  }, [draft, preview, reload, sending, tableId]);

  if (loadError && !table) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">表格加载失败</p>
        <div className="flex gap-2">
          <Button variant="neutral" onClick={() => navigate("/tables")}>
            返回列表
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setLoadError(false);
              setLoading(true);
              void reload()
                .then(() => setLoading(false))
                .catch(() => {
                  setLoadError(true);
                  setLoading(false);
                });
            }}
          >
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (!preview && loading && !table) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    );
  }

  if (!table) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">没有这张表</p>
        <Button variant="neutral" onClick={() => navigate("/tables")}>
          返回列表
        </Button>
      </div>
    );
  }

  return (
    <CanvasShell
      backAriaLabel="返回表格列表"
      onBack={() => navigate("/tables")}
      title={
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="未命名表格"
          aria-label="表格标题"
          className="min-w-0 max-w-xs flex-1 rounded-lg bg-transparent px-2 py-1 text-sm font-medium text-foreground outline-none hover:bg-accent focus:bg-accent"
        />
      }
      actions={
        <Button
          variant="neutral"
          onClick={() => {
            try {
              downloadCsv(table);
            } catch (err) {
              notifyError(err, "导出失败");
            }
          }}
        >
          导出 CSV
        </Button>
      }
    >
      <div className="absolute inset-0 flex flex-col">
        <div className="relative min-h-0 flex-1">
          <TableEditor
            key={table.id}
            table={table}
            onSelectionChange={onSelectionChange}
          />
        </div>
        {preview ? null : (
          <div className="shrink-0 border-t border-border bg-background px-3 py-2">
            {selectedIds.length > 0 || conversationId ? (
              <div className="mb-1.5 flex items-center justify-between gap-2">
                {selectedIds.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    已感知 {selectedIds.length} 行
                  </p>
                ) : (
                  <span />
                )}
                {conversationId ? (
                  <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => navigate(`/conversations/${conversationId}`)}
                  >
                    打开对话
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <Textarea
                aria-label="给表格 Agent 发消息"
                placeholder="让 Agent 筛选、填表或改视图…"
                value={draft}
                disabled={sending}
                rows={2}
                className="min-h-[2.5rem] flex-1"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              <Button
                variant="primary"
                disabled={sending || !draft.trim()}
                onClick={() => void handleSend()}
              >
                {sending ? "发送中…" : "发送"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </CanvasShell>
  );
}
