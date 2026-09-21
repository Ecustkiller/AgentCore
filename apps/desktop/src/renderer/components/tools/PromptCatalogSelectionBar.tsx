import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Trash2, X } from "lucide-react";

/**
 * 我的 / 市场条目多选时的操作条。只在 ≥2 项时出现——单选仍走行上右键。
 * 搬家不给独立按钮：拖选区内一张卡，整批换档。
 */
export function PromptCatalogSelectionBar({
  count,
  busy,
  onDelete,
  onClear,
}: {
  count: number;
  busy: boolean;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className="mb-3 flex items-center gap-1 rounded-lg bg-accent/60 py-1 pr-1 pl-3 text-xs"
      data-testid="prompt-selection-bar"
    >
      <span className="text-muted-foreground" aria-live="polite">
        已选择 {count} 项
      </span>
      <div className="flex-1" />
      <Button
        variant="danger"
        disabled={busy}
        onClick={onDelete}
        icon={<Trash2 size={13} />}
      >
        删除
      </Button>
      <SimpleTooltip label="清空选择（Esc）">
        <Button
          variant="ghost"
          aria-label="清空选择"
          onClick={onClear}
          icon={<X size={13} />}
          className="px-1.5"
        />
      </SimpleTooltip>
    </div>
  );
}
