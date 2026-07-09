import { Button } from "@/components/ui";
import { usePersistentDisclosure } from "@/stores/disclosure";
import type { LlmWindowMessage } from "@agentcore/contract-rest-types/llm-window";
import { ChevronDown, ChevronRight } from "lucide-react";

const ROLE_LABELS: Record<LlmWindowMessage["role"], string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
  tool: "工具",
};

function MessageBlock({
  message,
  index,
  keyBase,
}: {
  message: LlmWindowMessage;
  index: number;
  keyBase: string;
}) {
  const [expanded, setExpanded] = usePersistentDisclosure(
    `${keyBase}:msg:${index}`,
    index < 2,
  );
  const preview =
    message.content?.trim() ||
    message.reasoning_content?.trim() ||
    (message.tool_calls?.length
      ? `tool_calls × ${message.tool_calls.length}`
      : message.tool_call_id
        ? `tool:${message.tool_call_id}`
        : "（空）");
  const long = (preview?.length ?? 0) > 160;

  return (
    <div className="rounded-lg border border-border/60 bg-background">
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 rounded-lg px-2.5 py-2 hover:bg-muted/50"
      >
        <span className="flex w-full items-center gap-1.5">
          {long ? (
            expanded ? (
              <ChevronDown
                size={14}
                className="shrink-0 text-muted-foreground"
              />
            ) : (
              <ChevronRight
                size={14}
                className="shrink-0 text-muted-foreground"
              />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {ROLE_LABELS[message.role]}
          </span>
          {!expanded && long && (
            <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">
              {preview}
            </span>
          )}
        </span>
      </Button>

      {(expanded || !long) && (
        <div className="space-y-2 border-t border-border/40 px-2.5 py-2 text-xs">
          {message.reasoning_content ? (
            <div>
              <p className="mb-1 text-muted-foreground">reasoning</p>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted p-2 leading-relaxed text-muted-foreground">
                {message.reasoning_content}
              </pre>
            </div>
          ) : null}
          {message.content ? (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted p-2 leading-relaxed text-foreground">
              {message.content}
            </pre>
          ) : null}
          {message.tool_calls?.map((tc) => (
            <div
              key={tc.id}
              className="rounded bg-muted p-2 font-mono text-xs text-muted-foreground"
            >
              <div>{tc.function.name}</div>
              <pre className="mt-1 whitespace-pre-wrap break-words">
                {tc.function.arguments}
              </pre>
            </div>
          ))}
          {message.tool_call_id && message.role === "tool" ? (
            <p className="font-mono text-muted-foreground">
              id: {message.tool_call_id}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Diagnostic LLM input window — the messages actually fed to the model for this run,
 * folded from turn_journal via `window_from_journal`. Gated behind 诊断模式.
 */
export function LlmWindowSection({
  messages,
  available,
  loading,
  error,
  keyBase,
}: {
  messages: LlmWindowMessage[];
  available: boolean;
  loading: boolean;
  error: string | null;
  keyBase: string;
}) {
  const [expanded, setExpanded] = usePersistentDisclosure(
    `${keyBase}:llm-window`,
    false,
  );

  return (
    <section className="mb-4 last:mb-0">
      <Button
        variant="ghost"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto w-full justify-start gap-1.5 px-0 py-0 hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          <span className="flex-1 text-left text-xs font-medium text-muted-foreground">
            LLM 窗口
          </span>
          {loading && (
            <span className="shrink-0 text-xs text-muted-foreground">
              加载中…
            </span>
          )}
        </span>
      </Button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : loading ? (
            <p className="text-xs text-muted-foreground">正在折叠 journal…</p>
          ) : !available || messages.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              无法从 journal 重建此 run 的 LLM 窗口（可能缺少 execution
              facts）。
            </p>
          ) : (
            messages.map((message, index) => (
              <MessageBlock
                key={`${message.role}-${index}`}
                message={message}
                index={index}
                keyBase={keyBase}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
