import { foldToProjectedTurn } from "@/protocol/conformanceFold";
import { Files, Folder, Mail, Menu, MessageSquare, SquarePen, User } from "lucide-react";
import { useMemo } from "react";
import { AbsoluteFill } from "remotion";
import { AssistantProse, UserBubble } from "../../core/chrome/ChatBits";
import {
  MOBILE_FANOUT_EVENTS,
  MOBILE_FANOUT_USER_TEXT,
} from "../data/mobileFanoutEvents";

/*
 * 9:20 mobile chat still for 宣传图 #8. Narrow-screen chrome + desktop fold of a
 * truncated fan-out SSE vector (1/3 workers done). Does not import a second fold.
 */

export const MOBILE_W = 1080;
export const MOBILE_H = Math.round((MOBILE_W * 20) / 9);
export const MOBILE_LOGICAL_W = 390;
export const MOBILE_SCALE = MOBILE_W / MOBILE_LOGICAL_W;
export const MOBILE_LOGICAL_H = MOBILE_H / MOBILE_SCALE;

const TABS = [
  { label: "对话", Icon: MessageSquare, active: true },
  { label: "消息", Icon: Mail, active: false },
  { label: "文件", Icon: Files, active: false },
  { label: "我的", Icon: User, active: false },
] as const;

function workerStatus(agent: {
  status: string;
  output: string;
  toolProgress: { toolName: string; chars: number } | null;
}): string {
  if (agent.status === "completed") return agent.output || "已完成";
  if (agent.toolProgress) {
    return `${agent.toolProgress.toolName} · ${agent.toolProgress.chars} 字`;
  }
  if (agent.status === "working") return "进行中";
  return agent.status;
}

export function MobileChatStill() {
  const turn = useMemo(
    () => foldToProjectedTurn(MOBILE_FANOUT_EVENTS),
    [],
  );

  return (
    <AbsoluteFill>
      <div className="promo-mobile-still-root">
        <div
          className="promo-mobile-still-scale"
          style={{
            width: MOBILE_LOGICAL_W,
            height: MOBILE_LOGICAL_H,
            transform: `scale(${MOBILE_SCALE})`,
          }}
        >
          <div className="flex h-full flex-col bg-background text-foreground">
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
              <span className="flex size-8 items-center justify-center text-muted-foreground">
                <Menu size={20} />
              </span>
              <span className="text-sm font-medium">对话</span>
              <div className="flex items-center gap-1 text-muted-foreground">
                <span className="flex size-8 items-center justify-center">
                  <Folder size={20} />
                </span>
                <span className="flex size-8 items-center justify-center">
                  <SquarePen size={20} />
                </span>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3 py-3">
              <UserBubble text={MOBILE_FANOUT_USER_TEXT} />
              <AssistantProse text={turn.content} caret={false} />
              {turn.agents.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {turn.agents.map((agent) => (
                    <li
                      key={agent.id}
                      className="rounded-xl border border-border bg-card px-3 py-2"
                    >
                      <p className="text-sm font-medium">{agent.role}</p>
                      <p className="text-xs text-muted-foreground">
                        {workerStatus(agent)}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="shrink-0 border-t border-border px-3 py-2">
              <div className="flex h-10 items-center rounded-xl border border-border bg-card px-3 text-sm text-muted-foreground">
                说点什么…
              </div>
            </div>

            <nav className="flex h-14 shrink-0 border-t border-border">
              {TABS.map(({ label, Icon, active }) => (
                <span
                  key={label}
                  className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-xs ${
                    active ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  <Icon size={20} />
                  {label}
                </span>
              ))}
            </nav>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
}
