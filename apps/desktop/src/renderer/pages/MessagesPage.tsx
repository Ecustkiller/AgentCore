import { Mail } from "lucide-react";

export function MessagesPage() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <Mail size={28} className="text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">消息</p>
        <p className="text-xs text-muted-foreground/70">该功能后续实现</p>
      </div>
    </div>
  );
}
