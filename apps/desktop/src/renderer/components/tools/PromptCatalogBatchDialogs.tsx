import { Button, ConfirmDialog } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MineSelectedItem } from "@/lib/promptCatalogSelection";

export interface MineBatchConfirmState {
  items: readonly MineSelectedItem[];
  hasMarket: boolean;
  busy: boolean;
}

export interface MineBatchFailure {
  id: string;
  name: string;
  reason: string;
}

export interface MineBatchFailureState {
  title: string;
  failures: readonly MineBatchFailure[];
}

function ItemList({ items }: { items: readonly MineSelectedItem[] }) {
  return (
    <ul className="max-h-56 overflow-y-auto rounded-lg bg-muted/40 px-3 py-2">
      {items.map((item) => (
        <li key={item.catalogId} className="truncate py-0.5 text-xs">
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function confirmCopy(confirm: MineBatchConfirmState | null): {
  title: string;
  description: string;
} {
  const n = confirm?.items.length ?? 0;
  const marketNote = confirm?.hasMarket ? " 市场装来的卸装后可再装。" : "";
  if (n === 1) {
    return {
      title: `删除「${confirm?.items[0]?.label ?? ""}」？`,
      description: `此操作不可撤销。${marketNote}`,
    };
  }
  return {
    title: `删除这 ${n} 条？`,
    description: `此操作不可撤销。${marketNote}`,
  };
}

export function PromptCatalogBatchDialogs({
  confirm,
  onConfirmDelete,
  onCancelDelete,
  failure,
  onCloseFailure,
}: {
  confirm: MineBatchConfirmState | null;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  failure: MineBatchFailureState | null;
  onCloseFailure: () => void;
}) {
  const copy = confirmCopy(confirm);
  return (
    <>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) onCancelDelete();
        }}
        title={copy.title}
        description={copy.description}
        confirmLabel="删除"
        tone="danger"
        busy={confirm?.busy ?? false}
        onConfirm={onConfirmDelete}
      >
        {confirm && confirm.items.length > 1 ? (
          <ItemList items={confirm.items} />
        ) : null}
      </ConfirmDialog>

      <Dialog
        open={failure !== null}
        onOpenChange={(open) => {
          if (!open) onCloseFailure();
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{failure?.title}</DialogTitle>
            <DialogDescription>
              以下条目没有完成，其余项已生效。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {failure ? (
              <ul className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg bg-muted/40 px-3 py-2">
                {failure.failures.map((row) => (
                  <li key={row.id} className="text-xs">
                    <div className="truncate font-medium">{row.name}</div>
                    <p className="text-xs text-muted-foreground">
                      {row.reason}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="md" onClick={onCloseFailure}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
