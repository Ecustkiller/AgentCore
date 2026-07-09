import { hasTerminalRun } from "@/lib/capabilities";
import type { FileSource } from "@/lib/fileSource";
import type { Message } from "@/stores/conversation/types";

/** Aligned with server `completion.py` `_EXECUTION_TASK_HINTS` (Phase 1 auto-verify). */
export const EXECUTION_INTENT_RE =
  /(?:运行|启动|打开|安装|跑通|联调|验收|测试通过|npm\s+(?:run|start)|pnpm\s+(?:run|start)|yarn\s+(?:run|start|dev)|python\s+-m|uv\s+run|pip\s+run|cargo\s+run|go\s+run|进程)/i;

const BASH_FENCE_RE = /```(?:bash|sh)\s*\n([\s\S]*?)```/gi;

export function hasExecutionIntent(text: string): boolean {
  return EXECUTION_INTENT_RE.test(text);
}

export function hasLocalClientTools(source: FileSource | null): boolean {
  return (
    !!source &&
    (!!source.revealInOsFileManager ||
      !!source.openShellAtPath)
  );
}

export function findLatestUserMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return null;
}

/** Last fenced ```bash / ```sh block in assistant markdown (trimmed body). */
export function extractLastBashBlock(content: string): string | null {
  let last: string | null = null;
  for (const match of content.matchAll(BASH_FENCE_RE)) {
    const body = match[1]?.replace(/\n$/, "").trim();
    if (body) last = body;
  }
  return last;
}

export type ClientToolsHint = {
  bashCommand: string | null;
};

/**
 * Renderer-only visibility for the chat composer Client Tools card:
 * latest user turn hints run/open/install, turn finished, local workspace bound.
 */
export function deriveClientToolsHint(
  messages: Message[],
  source: FileSource | null,
  isGenerating: boolean,
): ClientToolsHint | null {
  if (isGenerating) return null;
  if (!hasLocalClientTools(source)) return null;

  const latestUser = findLatestUserMessage(messages);
  if (!latestUser || !hasExecutionIntent(latestUser.content)) return null;

  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.isStreaming) return null;

  const bashCommand = hasTerminalRun()
    ? extractLastBashBlock(last.content)
    : null;

  return { bashCommand };
}
