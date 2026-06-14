import { useExecutionStore } from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { GraphView } from "./GraphView";

export function GraphOverlay() {
  const closeGraph = useUIStore((s) => s.closeGraph);
  const taskSummary = useExecutionStore((s) => s.plan?.taskSummary);
  const [entered, setEntered] = useState(false);

  // 从右侧滑入（仅入场，无第三方依赖）。
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeGraph();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeGraph]);

  return (
    <div
      className={`absolute inset-0 z-20 flex flex-col bg-background transition-transform duration-300 ${
        entered ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <button
          type="button"
          onClick={closeGraph}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={16} />
          返回
        </button>
        {taskSummary && (
          <span className="truncate text-sm font-medium text-foreground">
            {taskSummary}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <GraphView />
      </div>
    </div>
  );
}
