import { notifyActionError } from "@/lib/toast";
import { hasAgentTownLauncher } from "@/lib/capabilities";
import { persistAgentTownSession } from "@/services/agentTownSession";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui";

export function OpenInAgentTownButton({
  runId,
  size = "sm",
  variant = "neutral",
}: {
  runId?: string;
  size?: "sm" | "md";
  variant?: "neutral" | "ghost" | "primary";
}) {
  const [launching, setLaunching] = useState(false);

  if (!hasAgentTownLauncher()) return null;

  const onLaunch = async () => {
    setLaunching(true);
    try {
      await persistAgentTownSession();
      const result = await window.agentTownApi!.launch(
        runId ? { runId } : undefined,
      );
      if (!result.ok) {
        notifyActionError("无法打开 AgentTown", new Error(result.message));
      }
    } catch (err) {
      notifyActionError("无法打开 AgentTown", err);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      disabled={launching}
      onClick={() => void onLaunch()}
      title="在独立 AgentTown 客户端中观看（推荐）"
    >
      <ExternalLink size={14} className="mr-1.5 shrink-0" />
      {launching ? "启动中…" : "在 AgentTown 中打开"}
    </Button>
  );
}
