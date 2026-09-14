import { PageContainer } from "@/components/layout/PageContainer";
import { Button, Card, EmptyHint, PageHeader } from "@/components/ui";
import { isWebPreview } from "@/lib/preview";
import {
  type TableSummary,
  createTable as createTableRemote,
  deleteTable as deleteTableRemote,
  listTables,
} from "@/services/tables";
import { useTablesStore } from "@/tables";
import { Loader2, Plus, Table2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TablesPage() {
  const navigate = useNavigate();
  const preview = isWebPreview();
  const localTables = useTablesStore((s) => s.tables);
  const createLocal = useTablesStore((s) => s.createTable);
  const deleteLocal = useTablesStore((s) => s.deleteTable);

  const [remote, setRemote] = useState<TableSummary[] | null>(
    preview ? [] : null,
  );
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (preview) return;
    setError(false);
    try {
      setRemote(await listTables());
    } catch {
      setError(true);
    }
  }, [preview]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = useCallback(async () => {
    if (preview) {
      const id = createLocal();
      navigate(`/tables/${id}`);
      return;
    }
    setCreating(true);
    try {
      const table = await createTableRemote();
      navigate(`/tables/${table.id}`);
    } catch {
      setError(true);
      setCreating(false);
    }
  }, [createLocal, navigate, preview]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (preview) {
        deleteLocal(id);
        setConfirmingId(null);
        return;
      }
      try {
        await deleteTableRemote(id);
        setRemote((prev) => prev?.filter((t) => t.id !== id) ?? null);
      } catch {
        setError(true);
      } finally {
        setConfirmingId(null);
      }
    },
    [deleteLocal, preview],
  );

  const createButton = () => (
    <Button
      variant="primary"
      size="md"
      icon={<Plus size={16} />}
      disabled={creating}
      onClick={() => void handleCreate()}
    >
      {creating ? "创建中…" : "新建表格"}
    </Button>
  );

  type ListItem = {
    id: string;
    title: string;
    rowLabel: string;
    updatedAt: string;
  };

  const items: ListItem[] | null = preview
    ? localTables.map((t) => ({
        id: t.id,
        title: t.title,
        rowLabel: `${t.rows.length} 行`,
        updatedAt: t.updatedAt,
      }))
    : (remote?.map((t) => ({
        id: t.id,
        title: t.title,
        rowLabel: `${t.rowCount} 行`,
        updatedAt: t.updatedAt,
      })) ?? null);

  return (
    <PageContainer width="canvas">
      <PageHeader title="多维表格" action={createButton()} />

      {error ? (
        <div className="mt-8 rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">加载失败</p>
          <Button
            variant="neutral"
            className="mt-3"
            onClick={() => void load()}
          >
            重试
          </Button>
        </div>
      ) : items === null ? (
        <div className="mt-16 flex justify-center">
          <Loader2 className="animate-spin text-muted-foreground" size={24} />
        </div>
      ) : items.length === 0 ? (
        <EmptyHint
          className="mt-16"
          icon={<Table2 className="text-muted-foreground/60" size={40} />}
          title="还没有表格"
          action={createButton()}
        />
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {items.map((table) => (
            <Card
              key={table.id}
              variant="interactive"
              className="group relative flex cursor-pointer flex-col gap-3 p-4 shadow-sm transition-shadow hover:shadow-md"
              onClick={() => navigate(`/tables/${table.id}`)}
            >
              <div className="flex h-16 items-center justify-center rounded-lg bg-muted">
                <Table2 className="text-muted-foreground/70" size={24} />
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium text-foreground">
                  {table.title}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {table.rowLabel} · 更新于 {formatUpdated(table.updatedAt)}
                </p>
              </div>
              {confirmingId === table.id ? (
                <button
                  type="button"
                  className="absolute right-2 top-2 rounded-lg bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(table.id);
                  }}
                >
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="删除表格"
                  className="absolute right-2 top-2 hidden rounded-lg p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(table.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </Card>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
