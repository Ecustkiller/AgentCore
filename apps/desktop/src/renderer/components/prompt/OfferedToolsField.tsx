/**
 * 按需技能封面：已绑定的查阅后启用手脚 + 搜索添加。
 * 不把出厂工具全表铺成芯片。
 */

import { Badge, SearchField } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface BindableToolOption {
  id: string;
  label: string;
}

const LABEL = "查阅后启用";
const HINT = "模型查阅这条才进工具表，常驻开场不带上。";

export function OfferedToolsField({
  selected,
  options,
  canAdd,
  readOnly,
  onChange,
}: {
  selected: string[];
  options: BindableToolOption[];
  canAdd: boolean;
  readOnly: boolean;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => {
    const map = new Map(options.map((tool) => [tool.id, tool]));
    return map;
  }, [options]);

  const selectedOptions = selected.map(
    (id) => byId.get(id) ?? { id, label: id },
  );
  const available = options.filter((tool) => !selected.includes(tool.id));
  const q = query.trim().toLowerCase();
  const filtered = q
    ? available.filter(
        (tool) =>
          tool.label.toLowerCase().includes(q) ||
          tool.id.toLowerCase().includes(q),
      )
    : available;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  if (selectedOptions.length === 0 && !canAdd) return null;

  function remove(id: string) {
    if (readOnly) return;
    onChange(selected.filter((row) => row !== id));
  }

  function add(id: string) {
    if (readOnly || selected.includes(id)) return;
    onChange([...selected, id]);
    setOpen(false);
  }

  return (
    <fieldset className="min-w-0 border-0 p-0" data-testid="offered-tools">
      <legend className="px-0 text-muted-foreground text-xs">{LABEL}</legend>
      <p className="mt-0.5 text-muted-foreground text-xs">{HINT}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {selectedOptions.map((tool) => (
          <Badge
            key={tool.id}
            as="button"
            type="button"
            pill
            tone="primary"
            disabled={readOnly}
            aria-label={`移除 ${tool.label}`}
            onClick={() => remove(tool.id)}
          >
            {tool.label}
          </Badge>
        ))}
        {canAdd && available.length > 0 && !readOnly ? (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Badge
                as="button"
                type="button"
                pill
                tone="muted"
                aria-expanded={open}
                aria-haspopup="dialog"
                data-testid="offered-tools-add"
              >
                <Plus size={12} className="mr-0.5" aria-hidden />
                添加
              </Badge>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="flex w-72 flex-col p-0"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <div className="border-b border-border px-2 py-1.5">
                <SearchField
                  ref={searchRef}
                  variant="plain"
                  size="sm"
                  value={query}
                  onValueChange={setQuery}
                  placeholder="搜索手脚"
                  aria-label="搜索手脚"
                />
              </div>
              <div className="max-h-48 overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <p className="px-3 py-2 text-muted-foreground text-xs">
                    没有匹配的手脚
                  </p>
                ) : (
                  filtered.map((tool) => (
                    <button
                      key={tool.id}
                      type="button"
                      className="flex w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => add(tool.id)}
                    >
                      {tool.label}
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </fieldset>
  );
}
