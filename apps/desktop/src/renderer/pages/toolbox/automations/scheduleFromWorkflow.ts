/**
 * 「设为定时」深链契约：工作流卡片 → 自动化 · 任务（预填绑定的新建抽屉）。
 *
 * 两页各持一半，参数名与拼装都收在这里，免得一边改名另一边静默失联。
 */

import { APP_PATHS } from "@/pages/toolbox/manual/paths";

const WORKFLOW_PARAM = "workflow";
const WORKFLOW_NAME_PARAM = "workflowName";

export interface ScheduleWorkflowDraft {
  workflowId: string;
  /** 只用于预填任务名与下拉回显；空串表示深链没带名字。 */
  workflowName: string;
}

/** 工作流卡片上的跳转目标。 */
export function scheduleFromWorkflowPath(workflow: {
  id: string;
  name: string;
}): string {
  const params = new URLSearchParams({ [WORKFLOW_PARAM]: workflow.id });
  const name = workflow.name.trim();
  if (name) params.set(WORKFLOW_NAME_PARAM, name);
  return `${APP_PATHS.toolbox.automations.root}?${params.toString()}`;
}

export function readScheduleFromWorkflow(
  params: URLSearchParams,
): ScheduleWorkflowDraft | null {
  const workflowId = params.get(WORKFLOW_PARAM)?.trim();
  if (!workflowId) return null;
  return {
    workflowId,
    workflowName: params.get(WORKFLOW_NAME_PARAM)?.trim() ?? "",
  };
}

/** 深链一次性：消费后从地址栏摘掉，刷新或返回不再重开抽屉。 */
export function withoutScheduleFromWorkflow(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(WORKFLOW_PARAM);
  next.delete(WORKFLOW_NAME_PARAM);
  return next;
}
