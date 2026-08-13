// 按人干预的两个 REST 通道（只停这一个队员 / 只改这一个队员的方向）。
//
// CEO 正卡在 `delegate` 里，这两条是绕过他的 user 直控通道。**能不能干预由服务端回答**：
// 响应里的 `accepted` 说这条 execution 此刻有没有活的驱动循环、这个 run 在不在当前计划里。
// 够不着就什么都不入队，界面据此如实交代，别拿 `queued`（整条执行的排队计数）冒充成功。
// 两者都**不结束这一轮**——主 Agent 与对话继续，兄弟队员照跑。
//
// 手机端只有云路径（桌面还有本地 sidecar 分支）。REST DTO 跟 OpenAPI 单一源。
import { apiFetch } from "@/api/client";
import type { components } from "@/types/api.generated";
import type { InterveneAck } from "@agentcore/protocol-fold-kit";

type Schemas = components["schemas"];

type SubmitRunStopResponse = Schemas["SubmitRunStopResponse"];
type SubmitRunRedirectResponse = Schemas["SubmitRunRedirectResponse"];

/** 服务端回执 + 排队计数（`queued` 只作诊断，判定看 `accepted`）。 */
export type RunInterveneAck = InterveneAck & { queued: number };

function toAck(
  data: SubmitRunStopResponse | SubmitRunRedirectResponse,
): RunInterveneAck {
  return {
    accepted: data.accepted ?? true,
    reason: data.reason ?? null,
    detail: data.detail ?? null,
    queued: data.queued ?? 0,
  };
}

/**
 * 只停这一个队员（`runId` 省略 = 停这张图上所有在飞/排队的队员）。
 *
 * 引擎确认之前不要把 run 画成「已停止」——那是替引擎撒谎，用户会以为已经停了。
 */
export async function submitRunStop(
  conversationId: string,
  params: { executionId: string; runId?: string | null },
): Promise<RunInterveneAck> {
  const res = await apiFetch(`/v1/conversations/${conversationId}/run-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      execution_id: params.executionId,
      run_id: params.runId ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`停止失败 (${res.status})`);
  }
  return toAck((await res.json()) as SubmitRunStopResponse);
}

/**
 * 只改这一个队员的方向。
 *
 * 受理后即取消这名队员在飞的工作，然后带着 feedback 重跑——能接现场就热续跑，接不上
 * 就同角色从头重做。任何确认文案都别说成「排队等下一步、暂时什么都没发生」；反过来，
 * `accepted=false` 时是真的什么都没发生，也不许说成已经改了。
 */
export async function submitRunRedirect(
  conversationId: string,
  params: { executionId: string; runId: string; feedback: string },
): Promise<RunInterveneAck> {
  const res = await apiFetch(
    `/v1/conversations/${conversationId}/run-redirect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        execution_id: params.executionId,
        run_id: params.runId,
        feedback: params.feedback,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`提交失败 (${res.status})`);
  }
  return toAck((await res.json()) as SubmitRunRedirectResponse);
}
