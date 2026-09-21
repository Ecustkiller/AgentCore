import { Button } from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type DocxLayout = "standard" | "official";

const LAYOUTS: { id: DocxLayout; title: string; hint: string }[] = [
  { id: "standard", title: "技术报告", hint: "说明、方案；无首行缩进" },
  { id: "official", title: "正式文书", hint: "首行缩进、公文页边距" },
];

/**
 * 文件树「导出 Word」的档位选择。动词已在右键说完，这里点哪行就导出哪档，
 * 不再二次确认。取消 / Esc / 点遮罩只关窗。
 */
export function ExportWordDialog({
  open,
  fileName,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  fileName: string;
  onOpenChange: (open: boolean) => void;
  onPick: (layout: DocxLayout) => void;
}) {
  const docxName = fileName.replace(/\.md$/i, ".docx");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>导出 Word</DialogTitle>
          <DialogDescription>同目录生成 {docxName}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-2">
            {LAYOUTS.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant="outline"
                size="md"
                className="h-auto w-full flex-col items-start justify-start gap-0.5 py-2 text-left"
                onClick={() => onPick(item.id)}
              >
                <span className="text-sm font-medium text-foreground">
                  {item.title}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {item.hint}
                </span>
              </Button>
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
