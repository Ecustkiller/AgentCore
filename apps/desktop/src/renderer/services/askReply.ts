import { sendTurn } from "@/services/turns";
import { sendMidFlightMessage } from "@/services/turns/midFlight";
import { getRuntime, useConversationStore } from "@/stores/conversation";

export type SendAskReplyResult = "ok" | "queued" | "send_failed";

/**
 * Answer a hanging question: send with ``ask_id`` (new turn or interjection).
 * Settlement is server-side after the turn is actually committed — this path
 * never POSTs ``question_posted``. Interjection ``queued`` is accepted (FIFO);
 * journal closes via server ingest on dequeue. ``unstartedRefusal`` is not a
 * run. Composer draft is left alone.
 */
export async function sendAskReply(args: {
  conversationId: string;
  askId: string;
  text: string;
}): Promise<SendAskReplyResult> {
  const text = args.text.trim();
  if (!text) throw new Error("缺少答复");

  const generating = getRuntime(args.conversationId).isGenerating;
  if (generating) {
    const mid = await sendMidFlightMessage(
      args.conversationId,
      text,
      undefined,
      "steer",
      undefined,
      args.askId,
    );
    if (mid.kind === "queued") return "queued";
    if (mid.kind !== "received") return "send_failed";
    return "ok";
  }

  const userMsgId = crypto.randomUUID();
  useConversationStore.getState().addMessage(
    {
      id: userMsgId,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
      executionId: null,
      isStreaming: false,
    },
    args.conversationId,
  );
  const sent = await sendTurn({
    conversationId: args.conversationId,
    content: text,
    attachments: [],
    optimisticUserId: userMsgId,
    delivery: "steer",
    askId: args.askId,
  });
  if (sent?.unstartedRefusal) return "send_failed";
  return "ok";
}
