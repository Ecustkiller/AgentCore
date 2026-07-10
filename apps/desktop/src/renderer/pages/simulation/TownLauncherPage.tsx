import { OpenInAgentTownButton } from "@/simulation/OpenInAgentTownButton";
import { SimulationRunManager } from "@/simulation/SimulationRunManager";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

/**
 * DT-01: Desktop launcher for AgentTown (spawn exe + session.json).
 * 3D observation lives in the Unity client — no embedded R3F.
 */
export function TownLauncherPage() {
  const [launchHint, setLaunchHint] = useState<{
    message: string;
    candidates?: string[];
  } | null>(null);

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
            Desktop 负责登录与启动；3D 观测、tick 推进与决策面板在 AgentTown
            客户端中完成。凭据已同步至 session.json。
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            开发期：先在仓库根目录执行{" "}
            <code className="rounded bg-muted px-1 py-0.5">pnpm town:build</code>
            ，生成{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              apps/town/Builds/Windows/AgentTown.exe
            </code>
            ；也可设置{" "}
            <code className="rounded bg-muted px-1 py-0.5">AGENTTOWN_PATH</code>。
          </p>
        </div>

        <OpenInAgentTownButton
          size="md"
          variant="primary"
          onLaunchError={setLaunchHint}
        />

        {launchHint ? (
          <div
            className="w-full max-w-lg rounded-xl border border-border bg-card p-4 text-left"
            role="alert"
          >
            <p className="text-sm text-foreground whitespace-pre-wrap">
              {launchHint.message}
            </p>
            {launchHint.candidates && launchHint.candidates.length > 0 ? (
              <div className="mt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  解析到的候选路径
                </p>
                <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground break-all">
                  {launchHint.candidates.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  建议：先跑{" "}
                  <code className="rounded bg-muted px-1">pnpm town:build</code>
                  ，或设置环境变量{" "}
                  <code className="rounded bg-muted px-1">AGENTTOWN_PATH</code>{" "}
                  指向可执行文件。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="w-full max-w-lg rounded-xl border border-border bg-card p-4">
          <p className="mb-3 text-xs font-medium text-muted-foreground">
            或先在此创建 / 恢复 run，再打开 AgentTown
          </p>
          <SimulationRunManager />
        </div>
      </div>
    </div>
  );
}
