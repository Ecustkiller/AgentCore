import { api } from "@/services/api";
import type { components } from "@/types/api.generated";
import type { SidecarTurnResult } from "@shared/sidecar-contract";

type RecordTurnResponse = components["schemas"]["RecordTurnResponse"];

/**
 * 把一次本地 sidecar 回合回写云端落库 + 计费（双模式工作区 / 远期规划 §一.1）。
 *
 * sidecar 在用户机器上跑完回合，本身无库可落；故 renderer 携回合结果调本接口，让云端把
 * user / assistant 消息入库（入库 / 跨设备），并按 `run_id` **幂等**落 `cost_events`
 * （计费回写——重试同一回合不会重复计费）。返回云端铸的权威 id，供调用方对账乐观气泡
 * （等价云链路的 `turn_saved` / `title_generated`）。
 *
 * 计费信任边界：回合在用户机器上跑，上报的 token / 定价由客户端给出，故仅对 BYOK 展示计费
 * 权威（用户直付 DeepSeek）；平台模式的权威计量须落在云推理代理（远期规划 §一 终态），
 * 不走这条客户端上报通路。
 */
export async function recordLocalTurn(
  conversationId: string,
  userMessage: string,
  result: SidecarTurnResult,
): Promise<RecordTurnResponse> {
  // 与服务端 `RecordTurnRequest`（snake_case）对齐：结果里的 citations / runs / costRuns
  // 已是落库形状，原样转发；token 总量作为 `Message.usage` 展示快照随行。
  const body = {
    user_message: userMessage,
    content: result.content,
    reasoning_content: result.reasoningContent,
    citations: result.citations,
    runs: result.runs,
    cost_runs: result.costRuns,
    message_id: result.messageId,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    rounds: result.rounds,
  } satisfies components["schemas"]["RecordTurnRequest"];

  return api.post<RecordTurnResponse>(
    `/v1/conversations/${conversationId}/local-turns`,
    body,
  );
}
