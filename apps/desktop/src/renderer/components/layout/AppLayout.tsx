import { Sidebar } from "../sidebar/Sidebar";
import { useUIStore, type ViewMode } from "@/stores/ui";

export function AppLayout() {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar (title + drag area + view toggle) */}
        <header className="flex h-10 items-center justify-between border-b border-border px-4 [-webkit-app-region:drag]">
          <span className="text-sm text-muted-foreground [-webkit-app-region:no-drag]">
            新对话
          </span>
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            <ViewToggle
              mode="chat"
              current={viewMode}
              onSelect={setViewMode}
              label="聊天"
            />
            <ViewToggle
              mode="graph"
              current={viewMode}
              onSelect={setViewMode}
              label="图"
            />
          </div>
        </header>

        {/* Page content (future: <Outlet />) */}
        <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-foreground">
              AgentCore
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Multi-Agent AI 工作台
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              输入消息开始对话
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}

function ViewToggle({
  mode,
  current,
  onSelect,
  label,
}: {
  mode: ViewMode;
  current: ViewMode;
  onSelect: (mode: ViewMode) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className={`rounded-lg px-3 py-1 text-sm transition-colors ${
        current === mode
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      {label}
    </button>
  );
}
