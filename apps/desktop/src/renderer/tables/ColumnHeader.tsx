import { Button, ConfirmDialog, Input, Select } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import {
  FIELD_TYPE_LABELS,
  OPTION_TONE_LABELS,
  defaultSelectOptions,
  isSortable,
} from "./fieldMeta";
import { newId } from "./ids";
import {
  type ColumnDef,
  FIELD_TYPES,
  type FieldType,
  OPTION_TONES,
  type SelectOption,
} from "./types";

export function ColumnHeader({
  column,
  canDelete,
  onUpdate,
  onHide,
  onRemove,
  onSort,
}: {
  column: ColumnDef;
  canDelete: boolean;
  onUpdate: (patch: Partial<ColumnDef>) => void;
  onHide: () => void;
  onRemove: () => void;
  onSort: (dir: "asc" | "desc") => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`列 ${column.label}`}
            className="flex w-full min-w-0 items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <span className="truncate">{column.label}</span>
            <ChevronDown size={12} className="shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            字段设置
          </DropdownMenuItem>
          {isSortable(column.type) ? (
            <>
              <DropdownMenuItem onSelect={() => onSort("asc")}>
                升序
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSort("desc")}>
                降序
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem onSelect={onHide}>隐藏</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="danger"
            disabled={!canDelete}
            onSelect={() => {
              if (canDelete) setConfirmOpen(true);
            }}
          >
            删除列
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ColumnSettingsDialog
        key={`${column.id}-${settingsOpen}`}
        column={column}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onUpdate={onUpdate}
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="删除这一列？"
        description="格子会一起丢掉，不能从这页撤回来。"
        confirmLabel="删除"
        tone="danger"
        onConfirm={() => {
          onRemove();
          setConfirmOpen(false);
        }}
      />
    </>
  );
}

function ColumnSettingsDialog({
  column,
  open,
  onOpenChange,
  onUpdate,
}: {
  column: ColumnDef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (patch: Partial<ColumnDef>) => void;
}) {
  const [label, setLabel] = useState(column.label);
  const [type, setType] = useState<FieldType>(column.type);
  const [options, setOptions] = useState<SelectOption[]>(
    column.options ?? defaultSelectOptions(),
  );

  const isSelect = type === "singleSelect" || type === "multiSelect";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>字段设置</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 pb-2">
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            名称
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="列名称"
            />
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            类型
            <Select
              aria-label="列类型"
              value={type}
              onChange={(e) => {
                const next = e.target.value as FieldType;
                setType(next);
                if (
                  (next === "singleSelect" || next === "multiSelect") &&
                  options.length === 0
                ) {
                  setOptions(defaultSelectOptions());
                }
              }}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>
          {isSelect ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">选项</p>
              {options.map((opt) => (
                <div key={opt.id} className="flex gap-1">
                  <Input
                    aria-label={`选项 ${opt.label}`}
                    className="flex-1"
                    value={opt.label}
                    onChange={(e) =>
                      setOptions((prev) =>
                        prev.map((o) =>
                          o.id === opt.id ? { ...o, label: e.target.value } : o,
                        ),
                      )
                    }
                  />
                  <Select
                    aria-label={`${opt.label} 颜色`}
                    className="w-20"
                    value={opt.tone ?? "gray"}
                    onChange={(e) =>
                      setOptions((prev) =>
                        prev.map((o) =>
                          o.id === opt.id
                            ? {
                                ...o,
                                tone: e.target.value as SelectOption["tone"],
                              }
                            : o,
                        ),
                      )
                    }
                  >
                    {OPTION_TONES.map((tone) => (
                      <option key={tone} value={tone}>
                        {OPTION_TONE_LABELS[tone]}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="neutral"
                    size="sm"
                    disabled={options.length <= 1}
                    onClick={() =>
                      setOptions((prev) => prev.filter((o) => o.id !== opt.id))
                    }
                  >
                    移除
                  </Button>
                </div>
              ))}
              <Button
                variant="neutral"
                size="sm"
                icon={<Plus size={14} />}
                onClick={() =>
                  setOptions((prev) => [
                    ...prev,
                    { id: newId(), label: "新选项", tone: "gray" },
                  ])
                }
              >
                添加选项
              </Button>
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="neutral" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const nextLabel = label.trim() || column.label;
              const patch: Partial<ColumnDef> = { label: nextLabel, type };
              if (isSelect) {
                patch.options = options.map((o) => ({
                  ...o,
                  label: o.label.trim() || "选项",
                }));
              } else {
                patch.options = undefined;
              }
              onUpdate(patch);
              onOpenChange(false);
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
