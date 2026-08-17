// 非阻塞提问卡 (ask_user blocking=false; 前端技术与架构 §七 · 手机端全新实现，对标桌面
// components/chat/NonBlockingAskCard.tsx)。内联只留 resolved：已答 / 已作废对人可见。
import type { NonBlockingAsk } from "@/protocol/fold";
import { Ban, Check } from "lucide-react";

export function NonBlockingAskCard({
  ask,
}: {
  ask: NonBlockingAsk;
  onFill?: (text: string) => void;
}) {
  if (ask.status !== "resolved") return null;

  const discarded = ask.settlement === "discarded";
  const label = discarded ? "已作废" : "已答";
  const body = discarded ? ask.note : ask.answer;

  return (
    <div
      className="ask ask-resolved"
      data-ask-status="resolved"
      data-ask-settlement={ask.settlement ?? ""}
    >
      <div className="ask-head">
        {discarded ? (
          <Ban size={14} className="ask-icon" aria-hidden />
        ) : (
          <Check size={14} className="ask-icon" aria-hidden />
        )}
        <span>{label}</span>
      </div>
      <div className="ask-q">{ask.question}</div>
      {ask.context && <div className="ask-context">{ask.context}</div>}
      {body ? <div className="ask-answer">{body}</div> : null}
    </div>
  );
}
