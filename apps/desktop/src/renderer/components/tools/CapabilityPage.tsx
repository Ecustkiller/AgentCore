import { PageContainer } from "@/components/layout/PageContainer";
import { ToolboxPageHeader } from "@/components/toolbox/ToolboxPageHeader";
import { Button } from "@/components/ui";
import type { Capabilities } from "@/services/capabilities";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCapabilities } from "./useCapabilities";

/** Shared shell for the 能力 sub-pages (工具 / AI 提示词): the toolbox header
 * (back link + capability segments) and the loading / error / ready states around
 * the shared capability fetch. The page supplies a render function that gets the
 * loaded data. */
export function CapabilityPage({
  note,
  children,
}: {
  /** 术语/范围说明，作为内容区第一行 muted 小字，不进页头。 */
  note?: ReactNode;
  children: (data: Capabilities) => ReactNode;
}) {
  const { data, status, reload } = useCapabilities();

  return (
    <PageContainer width="canvas">
      <ToolboxPageHeader />

      {note ? (
        <p className="mb-4 text-muted-foreground text-xs">{note}</p>
      ) : null}

      {status === "loading" && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground text-sm">
          <Loader2 size={16} className="animate-spin" />
          加载中…
        </div>
      )}
      {status === "error" && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border border-dashed py-16 text-center">
          <p className="text-muted-foreground text-sm">能力列表加载失败</p>
          <Button onClick={() => reload()}>重试</Button>
        </div>
      )}
      {status === "ready" && data && children(data)}
    </PageContainer>
  );
}
