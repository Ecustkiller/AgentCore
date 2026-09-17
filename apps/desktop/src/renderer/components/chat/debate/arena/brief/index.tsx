import { Card } from "@/components/ui";
import type { DebateBriefInfo, DebateSideInfo } from "@/types/events";
import { VerdictCard, YourCallZone, briefHandoffs } from "./shared";

/** 正反终审：同一套 Card——裁决 + 交接，不再分蓝底/白底两壳。 */
export function DebateBrief({
  brief,
  sides,
}: {
  brief: DebateBriefInfo;
  sides: DebateSideInfo[];
}) {
  const handoffs = briefHandoffs(brief);
  const rec = handoffs.length === 0 ? brief.recommendation : undefined;
  return (
    <Card className="p-4">
      <VerdictCard brief={brief} form="debate" sides={sides} />
      <YourCallZone
        divided
        handoffs={handoffs}
        recommendation={rec}
        form="debate"
      />
    </Card>
  );
}
