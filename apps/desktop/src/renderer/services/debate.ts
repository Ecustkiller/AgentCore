import { api } from "@/services/api";
import { getActiveSidecarTarget } from "@/services/sidecarRouting";

/**
 * Ambient debate steer — fire-and-forget boss intervention.
 * Applied at the next round boundary (辩论永不硬停).
 */
export type DebateSteerDecision =
  | { kind: "continue"; focus: string; ask: string; askTarget: string }
  | { kind: "conclude"; ask: string; askTarget: string };

export interface SubmitDebateSteerParams {
  executionId: string;
  decision: DebateSteerDecision;
}

/**
 * Queue an ambient steer for the live debate. Resolves to whether the engine took it.
 *
 * Local turns route to the sidecar (in-process queue); cloud turns POST the HTTP
 * endpoint. Never blocks the Moderator, but「已发送·下一轮生效」只在 `true` 时成立：
 * 末轮边界一过（结辩 + 简报可达数十秒）掌舵窗口就关了，那期间入的队没有边界来捞它，
 * 引擎会如实拒收 —— 调用方必须照这个结果改口。
 */
export async function submitDebateSteer(
  conversationId: string,
  params: SubmitDebateSteerParams,
): Promise<boolean> {
  const decision = params.decision.kind;
  const focus =
    params.decision.kind === "continue" ? params.decision.focus : "";
  const ask = params.decision.ask;
  const askTarget = params.decision.askTarget;

  const sidecarTarget = getActiveSidecarTarget(conversationId);
  if (sidecarTarget) {
    const { accepted } = await window.sidecarApi.debateSteer({
      rootId: sidecarTarget.rootId,
      subpath: sidecarTarget.subpath,
      conversationId,
      executionId: params.executionId,
      decision,
      focus,
      ask,
      askTarget,
    });
    return accepted;
  }
  const res = await api.post<{ ok?: boolean }>(
    `/v1/conversations/${conversationId}/debate-steer`,
    {
      execution_id: params.executionId,
      decision,
      focus,
      ask,
      ask_target: askTarget,
    },
  );
  return res?.ok === true;
}
