import { RunDetailBody } from "@/components/chat/detail/RunDetailBody";
import { useDetailPanelStore } from "@/stores/detailPanel";
import { useProjectedExecution } from "@/stores/execution";
import { useUIStore } from "@/stores/ui";
import { PanelRight, X } from "lucide-react";

interface Props {
  nodeId: string;
  onClose: () => void;
}

/** Graph-side chrome around the shared {@link RunDetailBody} drill-down. */
export function NodeDetail({ nodeId, onClose }: Props) {
  const execution = useProjectedExecution();
  const closeGraph = useUIStore((s) => s.closeGraph);

  if (!execution?.runs.some((s) => s.id === nodeId)) return null;

  // Hand the selection to the conversation detail panel, then drop the overlay
  // so the same run is shown in-chat.
  const viewInPanel = () => {
    const run = execution?.runs.find((r) => r.id === nodeId);
    const role = execution?.agents.find((a) => a.id === run?.agentId)?.role;
    useDetailPanelStore.getState().showRunDetail(nodeId, role);
    closeGraph();
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
        <RunDetailBody runId={nodeId} />
      </div>
    </div>
  );
}
