import { hasAgentTownLauncher } from "@/lib/capabilities";
import { OpenInAgentTownButton } from "@/simulation/OpenInAgentTownButton";
import { SimulationRunManager } from "@/simulation/SimulationRunManager";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * DT-01: Desktop launcher-first entry for AgentTown (R3F frozen as ?preview=1 only).
 */
export function TownLauncherPage() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link
          to="/"
          className="flex shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="返回首页"
          title="返回首页"
        >
          <ArrowLeft size={18} />
        </Link>
        <div className="min-w-0">
          <h1 className="text-sm font-medium text-foreground">AI 小镇</h1>
          <p className="text-xs text-muted-foreground">
            在 AgentTown 独立客户端中观看 3D 模拟（推荐）
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-10">
        <div className="max-w-md text-center">
          <h2 className="text-base font-medium text-foreground">
            打开 AgentTown
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Desktop 负责登录与启动；3D 观测、tick 推进与决策面板在
            AgentTown 客户端中完成。凭据已同步至 session.json。
          </p>
        </div>

        <OpenInAgentTownButton size="md" variant="primary" />

        <div className="w-full max-w-lg rounded-xl border border-border bg-card p-4">
          <p className="mb-3 text-xs font-medium text-muted-foreground">
            或先在此创建 / 恢复 run，再打开 AgentTown
          </p>
          <SimulationRunManager />
        </div>

        <Link
          to="/simulation/town?preview=1"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          开发对照：内嵌 R3F 预览（冻结，仅离线/联调）
        </Link>
      </div>
    </div>
  );
}

/** Link to frozen R3F preview from other surfaces. */
export function TownPreviewLink() {
  if (!hasAgentTownLauncher()) return null;
  return (
    <Link
      to="/simulation/town?preview=1"
      className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      R3F 对照预览
    </Link>
  );
}
