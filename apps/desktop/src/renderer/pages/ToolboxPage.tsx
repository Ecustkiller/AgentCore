import { Wrench } from "lucide-react";

export function ToolboxPage() {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
        <h1 className="text-xl font-semibold text-foreground">工具箱</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理 MCP 工具与插件
        </p>

        <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
          <Wrench size={28} className="text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">暂无已接入的工具</p>
          <p className="text-xs text-muted-foreground/70">
            接入 MCP 工具或插件后将在此管理
          </p>
        </div>
      </div>
    </div>
  );
}
