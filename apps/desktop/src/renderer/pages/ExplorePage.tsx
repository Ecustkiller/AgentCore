import { Compass } from "lucide-react";

export function ExplorePage() {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
        <h1 className="text-xl font-semibold text-foreground">探索</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          发现公共 Agent、团队、模板与工具
        </p>

        <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
          <Compass size={28} className="text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">内容即将上线</p>
          <p className="text-xs text-muted-foreground/70">
            上架的公共资源将在此以网格形式展示
          </p>
        </div>
      </div>
    </div>
  );
}
