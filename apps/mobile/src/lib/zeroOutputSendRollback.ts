/**
 * Class B 零产出回滚：本发已落库、助手空失败、能力/限流码 → 撤 live turn、草稿还回输入框。
 * 与 Class A（`isUnstartedSendRefusal` · SSE 未开 / 用户句未落库）分立，禁止并进。
 */
import { withLocalRecoveryMoment } from "@/lib/recoveryMoment";
import {
  type ContentDeltaPayload,
  type ErrorPayload,
  type SSEEvent,
  isZeroOutputSendRefusalCode,
} from "@agentcore/contract-types";

export type ZeroOutputSendRollback = {
  rollback: boolean;
  errorCode?: string;
  errorMessage?: string;
  credentialSource?: string | null;
};

function turnPersisted(events: readonly SSEEvent[]): boolean {
  return events.some((e) => e.type === "turn_saved");
}

/** 可见助手正文（content_reset 后重写版为准）。推理不算正文。 */
function assistantHasBody(events: readonly SSEEvent[]): boolean {
  let content = "";
  for (const e of events) {
    if (e.type === "content_reset") {
      content = "";
      continue;
    }
    if (e.type !== "content_delta") continue;
    const p = e.payload as ContentDeltaPayload;
    const d = p.delta || "";
    content = p.replace === true ? d : content + d;
  }
  return Boolean(content.trim());
}

function assistantHasTools(events: readonly SSEEvent[]): boolean {
  return events.some((e) => e.type === "tool_use_start");
}

/**
 * 只根据本发 SSE 事件判定是否 Class B 回滚。retry / regenerate 不得调用。
 */
export function inspectZeroOutputSendRollback(
  events: readonly SSEEvent[],
): ZeroOutputSendRollback {
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let credentialSource: string | null | undefined;
  for (const e of events) {
    if (e.type !== "error") continue;
    const p = e.payload as ErrorPayload;
    errorCode = p.code;
    errorMessage = withLocalRecoveryMoment(p.message, {
      code: p.code,
      context: p.context,
    });
    credentialSource = p.context?.credential_source;
  }
  const rollback =
    turnPersisted(events) &&
    isZeroOutputSendRefusalCode(errorCode) &&
    !assistantHasBody(events) &&
    !assistantHasTools(events);
  return { rollback, errorCode, errorMessage, credentialSource };
}
