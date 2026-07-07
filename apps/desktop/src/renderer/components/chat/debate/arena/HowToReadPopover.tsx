import { Button } from "@/components/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Info } from "lucide-react";
import { type DebateForm, debateFormBlurb } from "../model";

/** 全页唯一概念解释入口（收编质询/结辩/记分/举证等）。 */
export function HowToReadPopover({ form }: { form: DebateForm }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground"
          icon={<Info size={13} />}
        >
          这场怎么读
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-w-sm text-sm" align="end">
        <p className="font-medium text-foreground">怎么读这场辩论</p>
        <p className="mt-2 text-muted-foreground">{debateFormBlurb(form)}</p>
        <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">记分牌</span>
            ：累计净分与逐轮动量，佐证下方裁决倾向。
          </li>
          <li>
            <span className="font-medium text-foreground">质询</span>
            ：主持人当面追问，圆点表示是否正面回答。
          </li>
          <li>
            <span className="font-medium text-foreground">结辩</span>
            ：各方最后陈词，只讲胜负手。
          </li>
          <li>
            <span className="font-medium text-foreground">站队</span>
            ：仅你可见的倾向标记，不影响 AI 裁决。
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
