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
 * 计费信任边界（Slice 4a 起）：sidecar 的 LLM 调用全部经云端推理代理（`/v1/inference`），由
 * 代理按真实上游 usage **权威**落 `cost_events`（平台 / BYOK 皆然）。故本回写**不再上报
 * `cost_runs`**——否则与代理重复计费。客户端只回写消息正文 / 引用 / 团队图等展示物，钱由代理算。
 *
 * 回写可靠性（双模式工作区 §一.1）：网络抖动不该让回合从云历史里消失，故本函数对 POST 做
 * **有限退避重试**。重试安全的前提是回写**幂等**——服务端按客户端铸的 `user_message_id`
 * （+ `run_id`）去重，故「已提交但响应丢了」后的重试绝不重复落回合 / 重复计费（见服务端
 * `record_local_turn`）。重试仍失败则上抛，由调用方出**非阻断**降级提示 + 手动重试。
 */

/** 回写重试上限（含首次）。幂等保证多次尝试安全；超过则上抛由调用方降级。 */
const MAX_WRITE_BACK_ATTEMPTS = 3;

export async function recordLocalTurn(
  conversationId: string,
  userMessage: string,
  /** 本轮用户气泡的客户端 id（干净 UUID）——作为幂等锚随 body 上报。 */
  userMessageId: string,
  /** 本回合 trace_id（32-hex）——同回合云代理 LLM 调用所带，服务端复用它落到 assistant
   *  消息，使推理日志↔气泡同 trace（打通气泡↔日志）。 */
  traceId: string,
  result: SidecarTurnResult,
): Promise<RecordTurnResponse> {
  // 与服务端 `RecordTurnRequest`（snake_case）对齐：结果里的 citations / runs 已是落库形状，
  // 原样转发；token 总量作为 `Message.usage` 展示快照随行。**不报成本**——计费由云推理代理权威
  // 落账（见上「计费信任边界」），故 `RecordTurnRequest` 已无 `cost_runs` 字段。
  const body = {
    user_message: userMessage,
    user_message_id: userMessageId,
    content: result.content,
    reasoning_content: result.reasoningContent,
    citations: result.citations,
    runs: result.runs,
    message_id: result.messageId,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    rounds: result.rounds,
    trace_id: traceId,
  } satisfies components["schemas"]["RecordTurnRequest"];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_WRITE_BACK_ATTEMPTS; attempt++) {
    try {
      return await api.post<RecordTurnResponse>(
        `/v1/conversations/${conversationId}/local-turns`,
        body,
      );
    } catch (err) {
      lastError = err;
      // 指数退避（0.5s, 1s）后再试；最后一次失败不等待，直接上抛。
      if (attempt < MAX_WRITE_BACK_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * 2 ** (attempt - 1)),
        );
      }
    }
  }
  throw lastError;
}
