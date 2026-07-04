import { Button } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ArrowDown, Columns2, List } from "lucide-react";

/**
 * 流内工具条（读法控件·群聊本体顶部 sticky）—— 判/记分/掌舵已并入右侧面板裁判台（{@link
 * import("../DebateHud").DebateHudRegion}），本流只留「怎么读」：**流式/并排**（仅正反 2 方 · 对比并入
 * 群聊 §4.1b/§6.5，逐轮还可就地「并排看此轮」覆盖此默认）+ **结论↓** 锚（收场，滚到流末主持人终审）。
 * 两者都不适用时不渲染（无工具条）。
 */
export function FlowToolbar({
  isVersus,
  globalParallel,
  onSetParallel,
  settled,
  onScrollVerdict,
}: {
  isVersus: boolean;
  globalParallel: boolean;
  onSetParallel: (on: boolean) => void;
  settled: boolean;
  onScrollVerdict: () => void;
}) {
  if (!isVersus && !settled) return null;
  return (
    <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-background/80 px-1 py-1 backdrop-blur">
      <span className="min-w-0 flex-1" />
      {isVersus && (
        <SimpleTooltip label="流式=顺着读；并排=正反两方逐轮左右对垒（也可逐轮单独切）">
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
            <Button
              variant="ghost"
              onClick={() => onSetParallel(false)}
              aria-pressed={!globalParallel}
              icon={<List size={13} />}
              className={
                globalParallel
                  ? "text-muted-foreground"
                  : "bg-accent text-foreground hover:bg-accent"
              }
            >
              流式
            </Button>
            <Button
              variant="ghost"
              onClick={() => onSetParallel(true)}
              aria-pressed={globalParallel}
              icon={<Columns2 size={13} />}
              className={
                globalParallel
                  ? "bg-accent text-foreground hover:bg-accent"
                  : "text-muted-foreground"
              }
            >
              并排
            </Button>
          </div>
        </SimpleTooltip>
      )}
      {settled && (
        <SimpleTooltip label="跳到流末主持人终审">
          <Button
            variant="ghost"
            onClick={onScrollVerdict}
            className="h-auto shrink-0 px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-transparent"
            icon={<ArrowDown size={14} />}
          >
            结论
          </Button>
        </SimpleTooltip>
      )}
    </div>
  );
}
