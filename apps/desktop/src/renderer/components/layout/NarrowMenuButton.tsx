import { IconButton } from "@/components/ui";
import { useNarrowLayoutState } from "@/lib/narrowLayout";
import { useUnreadTotal } from "@/stores/messaging";
import { Menu } from "lucide-react";

/** 窄屏根页打开与桌面同一棵侧栏（overlay）。未读角标补 overlay 关上时看不见「消息」行。 */
export function NarrowMenuButton() {
  const { setConversationDrawerOpen } = useNarrowLayoutState();
  const unread = useUnreadTotal();

  return (
    <IconButton
      size="md"
      className="relative"
      aria-label={unread > 0 ? `打开侧栏，${unread} 条未读` : "打开侧栏"}
      onClick={() => setConversationDrawerOpen(true)}
    >
      <Menu size={18} />
      {unread > 0 && (
        <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
      )}
    </IconButton>
  );
}
