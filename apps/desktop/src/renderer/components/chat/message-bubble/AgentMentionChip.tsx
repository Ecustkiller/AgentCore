import { SimpleTooltip } from "@/components/ui/tooltip";
import { Users } from "lucide-react";

/** History-bubble ``@`` role chip (soft mention; not an attachment kind). */
export function AgentMentionChip({ role }: { role: string }) {
  return (
    <SimpleTooltip label={role}>
      <span className="inline-flex max-w-[220px] items-center gap-1.5 rounded-lg bg-accent px-2 py-1 text-xs text-accent-foreground">
        <Users size={12} className="shrink-0" />
        <span className="shrink-0 text-muted-foreground">点名</span>
        <span className="truncate">{role}</span>
      </span>
    </SimpleTooltip>
  );
}
