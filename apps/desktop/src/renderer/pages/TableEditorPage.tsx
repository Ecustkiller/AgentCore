import { CanvasShell } from "@/components/layout/CanvasShell";
import { Button } from "@/components/ui";
import { isWebPreview } from "@/lib/preview";
import { notifyError } from "@/lib/toast";
import { getTable, renameTable as renameTableRemote } from "@/services/tables";
import { TableEditor, useTablesStore } from "@/tables";
import { installTablesRemote } from "@/tables/remote";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
      status={
        table.sourcePath ? (
          <span className="max-w-[14rem] truncate" title={table.sourcePath}>
            {table.sourcePath}
          </span>
        ) : undefined
      }
    >
      <TableEditor key={table.id} table={table} />
    </CanvasShell>
  );
}
