import { Button } from "@/components/ui";
import { useConversationFileSource } from "@/hooks/useConversationFileSource";
import { deriveClientToolsHint } from "@/lib/clientToolHints";
import { detectProjectRunCommands } from "@/lib/detectRunCommands";
import { hasTerminalRun } from "@/lib/capabilities";
import { runTerminalBash } from "@/lib/terminalFeedback";
import { notifyActionError } from "@/lib/toast";
import { openFileSourceShell } from "@/services/terminalActions";
import {
  useActiveGenerating,
  useActiveMessages,
  useConversationStore,
} from "@/stores/conversation";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Laptop, Play, Terminal } from "lucide-react";
import { useMemo } from "react";

function truncateCommand(cmd: string, max = 36): string {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Chat composer Client Tools shortcut card (minimal Agent-triggered local ops):
 * when the latest user message hints run/open/install, the turn has finished,
 * and the conversation binds a local workspace, surface one-click folder / shell /
 * optional bash-run actions above the composer.
 */
export function ClientToolsPrompt() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const messages = useActiveMessages();
  const isGenerating = useActiveGenerating();
  const source = useConversationFileSource(conversationId);

  const hint = useMemo(
    () => deriveClientToolsHint(messages, source, isGenerating),
    [messages, source, isGenerating],
  );

  const { data: projectRuns = [] } = useQuery({
    queryKey: ["project-run-commands", source?.id],
    queryFn: () => detectProjectRunCommands(source!),
    enabled: !!hint && !!source,
    staleTime: 60_000,
  });

  if (!hint || !source) return null;

  const canReveal = !!source.revealInOsFileManager;
  const canShell = !!source.openShellAtPath;
  const bashCommand =
    hint.bashCommand && hasTerminalRun() ? hint.bashCommand : null;
  const runCommands = bashCommand
    ? [bashCommand]
    : projectRuns.filter((c) => hasTerminalRun());
  if (!canReveal && !canShell && runCommands.length === 0) return null;

  const openFolder = async () => {
    try {
      await source.revealInOsFileManager?.("");
    } catch (e) {
      notifyActionError("无法打开文件夹", e);
    }
  };

  return (
    <div className="px-4 pb-2">
      <div className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Laptop size={12} className="shrink-0" />
        <span>本机快捷操作</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {canReveal && (
          <Button
            variant="neutral"
            className="h-auto border border-border bg-card py-1 text-muted-foreground hover:border-primary/40 hover:text-foreground"
            icon={<FolderOpen size={13} />}
            onClick={() => void openFolder()}
          >
            打开文件夹
          </Button>
        )}
        {canShell && (
          <Button
            variant="neutral"
            className="h-auto border border-border bg-card py-1 text-muted-foreground hover:border-primary/40 hover:text-foreground"
            icon={<Terminal size={13} />}
            onClick={() => void openFileSourceShell(source, ".")}
          >
            打开终端
          </Button>
        )}
        {runCommands.map((cmd) => (
          <Button
            key={cmd}
            variant="neutral"
            className="h-auto max-w-full border border-border bg-card py-1 text-muted-foreground hover:border-primary/40 hover:text-foreground"
            icon={<Play size={13} />}
            title={cmd}
            onClick={() => void runTerminalBash(cmd)}
          >
            运行 {truncateCommand(cmd)}
          </Button>
        ))}
      </div>
    </div>
  );
}
