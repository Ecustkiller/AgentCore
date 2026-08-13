import type { FileSortBy } from "@/components/files/fileTreeTypes";
import { IconButton } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ArrowDownUp, Check } from "lucide-react";

const OPTIONS: { value: FileSortBy; label: string }[] = [
  { value: "name", label: "名称" },
  { value: "size", label: "大小（大的在前）" },
  { value: "mtime", label: "修改时间（新的在前）" },
];

/** Menu label of a sort key — also the trigger tooltip, so the current mode is
 * readable without opening the menu. */
export function fileSortLabel(by: FileSortBy): string {
  return OPTIONS.find((o) => o.value === by)?.label ?? "名称";
}

/**
 * 文件中枢顶栏的排序选择器（筛选框右侧）。
 *
 * 一个中枢一个值：换的是「我现在想怎么看文件」，不是某个文件夹的属性，所以所有根共用、
 * 并作为偏好持久化。文件夹恒在文件之前（见 {@link FileSortBy}），这里只决定同档内先后。
 * 切换只重排已加载的层，不触发任何请求。
 */
export function FileSortMenu({
  value,
  onChange,
}: {
  value: FileSortBy;
  onChange: (by: FileSortBy) => void;
}) {
  return (
    <DropdownMenu>
      <SimpleTooltip label={`排序：${fileSortLabel(value)}`}>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={`排序方式：${fileSortLabel(value)}`}>
            <ArrowDownUp size={13} />
          </IconButton>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>排序方式</DropdownMenuLabel>
        {OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)}>
            <Check
              size={14}
              className={o.value === value ? "shrink-0" : "shrink-0 opacity-0"}
            />
            <span className="flex-1 truncate">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
