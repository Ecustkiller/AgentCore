import { Button, IconButton } from "@/components/ui";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { formatMessageTime } from "@/lib/format";
import { Check, RefreshCw, X } from "lucide-react";
import { useState } from "react";

/** Small icon+label action shown beneath a message on hover. */
export function MessageAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="neutral" className="px-1.5" icon={icon} onClick={onClick}>
      {label}
    </Button>
  );
}

/**
 * Assistant footer regenerate — always confirm (定案：截断其后历史 + 新贵回合，不可逆).
 * Does not cover edit-and-resend on the user bubble (intentional edit path).
 */
export function RegenerateMessageAction({
  onRegenerate,
}: { onRegenerate: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-0.5">
        <SimpleTooltip label="确认重新生成">
          <IconButton
            size="sm"
            tone="destructive"
            aria-label="确认重新生成"
            onClick={() => {
              setConfirming(false);
              onRegenerate();
            }}
          >
            <Check size={14} />
          </IconButton>
        </SimpleTooltip>
        <SimpleTooltip label="取消">
          <IconButton
            size="sm"
            aria-label="取消"
            onClick={() => setConfirming(false)}
          >
            <X size={14} />
          </IconButton>
        </SimpleTooltip>
      </span>
    );
  }

  return (
    <SimpleTooltip label="重新生成">
      <IconButton
        size="sm"
        aria-label="重新生成"
        onClick={() => setConfirming(true)}
      >
        <RefreshCw size={14} />
      </IconButton>
    </SimpleTooltip>
  );
}

export function MessageTime({ iso }: { iso: string }) {
  const label = formatMessageTime(iso);
  if (!label) return null;
  return (
    <SimpleTooltip label={new Date(iso).toLocaleString()}>
      <span className="ml-1 cursor-default text-xs text-muted-foreground/60">
        {label}
      </span>
    </SimpleTooltip>
  );
}
