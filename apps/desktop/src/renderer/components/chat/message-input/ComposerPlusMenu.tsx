import { IconButton } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Plus } from "lucide-react";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

const ComposerPlusCloseContext = createContext<(() => void) | null>(null);

/** Close the open bar「＋」menu (no-op outside the menu). */
export function useComposerPlusClose(): (() => void) | null {
  return useContext(ComposerPlusCloseContext);
}

/**
 * 底栏 bar 的「＋」外壳：低频/绑定后少改的会话配置由调用方塞进菜单。
 * 嵌套 chip 自带 Popover / 绝对面板，故 `overflow-visible`，并忽略点到其它
 * popper 内容时的 outside dismiss（否则一开模型下拉就会把＋关掉并卸掉触发器）。
 */
export function ComposerPlusMenu({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const closeCtx = useMemo(() => close, [close]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <IconButton
          size="md"
          disabled={disabled}
          aria-label="更多选项"
          aria-expanded={open}
          data-testid="composer-plus-trigger"
        >
          <Plus size={16} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-max overflow-visible p-2"
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          const t = e.target;
          if (!(t instanceof Element)) return;
          if (
            t.closest(
              "[data-radix-popper-content-wrapper], [data-radix-menu-content], [role='listbox']",
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <ComposerPlusCloseContext.Provider value={closeCtx}>
          <div
            className="flex w-max min-w-0 flex-col items-stretch gap-1"
            data-testid="composer-plus-menu"
          >
            {children}
          </div>
        </ComposerPlusCloseContext.Provider>
      </PopoverContent>
    </Popover>
  );
}
