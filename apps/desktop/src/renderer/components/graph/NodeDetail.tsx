import { RunDetailBody } from "@/components/chat/detail/RunDetailBody";
import { useDetailPanelStore } from "@/stores/detailPanel";
import { useExecutionScope, useMessageExecution } from "@/stores/execution";
import { PanelRight, X } from "lucide-react";

interface Props {
  nodeId: string;
  onClose: () => void;
  /** Exit the surrounding full-screen overlay (after handing a run to the chat
   * panel, the overlay steps aside so the same run shows in-chat). */
  onExit?: () => void;
}

/** Graph-side chrome around the shared {@link RunDetailBody} drill-down. */
export function NodeDetail({ nodeId, onClose, onExit }: Props) {
  // This graph's message slot (§9.3) — drilling stays within its own turn.
  const messageId = useExecutionScope();
  const execution = useMessageExecution(messageId);

  if (!messageId || !execution?.runs.some((s) => s.id === nodeId)) return null;

  // Hand the selection to the conversation detail panel, then drop the overlay
  // so the same run is shown in-chat.
  const viewInPanel = () => {
    const run = execution?.runs.find((r) => r.id === nodeId);
    const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
    useDetailPanelStore.getState().showRunDetail(messageId, nodeId, role);
    onExit?.();
  };

  return (
    <div className="flex w-72 flex-col border-l border-border bg-card">
      <div className="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-border px-2">
        <button
          type="button"
          onClick={viewInPanel}
          title="在对话详情面板中查看"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelRight size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <RunDetailBody messageId={messageId} runId={nodeId} />
      </div>
    </div>
  );
}
