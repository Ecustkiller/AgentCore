import { useState } from "react";

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      {sidebarOpen && (
        <aside className="flex w-[260px] flex-shrink-0 flex-col border-r border-border bg-card">
          <div className="flex h-14 items-center justify-between border-b border-border px-4">
            <h1 className="text-lg font-semibold">AgentCore</h1>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-accent"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {/* ConversationList placeholder */}
            <p className="px-2 py-4 text-sm text-muted-foreground">
              暂无对话
            </p>
          </div>
          <div className="border-t border-border p-2">
            <button
              type="button"
              className="w-full rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            >
              新建对话
            </button>
          </div>
        </aside>
      )}

      {/* Main Content */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-14 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
              >
                ☰
              </button>
            )}
            <span className="text-sm text-muted-foreground">新对话</span>
          </div>
          <div className="flex items-center gap-2">
            {/* ViewToggle placeholder */}
            <button
              type="button"
              className="rounded px-3 py-1 text-sm text-muted-foreground hover:bg-accent"
            >
              聊天
            </button>
            <button
              type="button"
              className="rounded px-3 py-1 text-sm text-muted-foreground hover:bg-accent"
            >
              图
            </button>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex flex-1 items-center justify-center overflow-hidden">
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-foreground">
              AgentCore
            </h2>
            <p className="mt-2 text-muted-foreground">
              Multi-Agent AI 工作台
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              输入消息开始对话
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
