/**
 * 「跑一次」打开时按需抽出可换参数。
 *
 * 只在对话框打开、这条工作流还没有槽位、且它来自对话固化时抽一次：历史行仍可能
 * 是固化来源，用户第二次要用、看到任务里写死着上一轮主题时才需要槽位。抽完摆出来
 * 让用户当场过目。
 *
 * 抽一次要真跑模型（最长约 20 秒），因此它不挡任何东西：等的过程中「开跑」照常可点
 * （不带覆盖 = 原样重跑），抽不出来或请求失败都静默退回今天的无参数形态。
 */

import {
  type WorkflowDefinition,
  type WorkflowSlot,
  workflowSlots,
} from "@/services/workflowDefinition";
import {
  type WorkflowSource,
  isWorkflowFromTurn,
} from "@/services/workflowSource";
import { type UserWorkflow, suggestWorkflowSlots } from "@/services/workflows";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 本次会话里「抽过一次、一个槽位都没抽出来」的工作流。抽一次最长要等 20 秒，同一条
 * 工作流每开一次对话框就再白等一遍没道理；请求失败不记进来——那是可重试的。
 */
const NOTHING_EXTRACTED = new Set<string>();

export interface SuggestedSlotsState {
  /** 摆给用户过目的槽位：definition 里已有的那份，或这次刚抽出来的那份。 */
  slots: WorkflowSlot[];
  /** 抽取在飞：给诚实的等待反馈，但不禁用「开跑」。 */
  pending: boolean;
  /** 槽位是这次刚抽出来的：抽得对不对要用户当场看一眼。 */
  fresh: boolean;
}

export function useSuggestedSlots({
  open,
  workflowId,
  definition,
  source,
  onSuggested,
}: {
  open: boolean;
  workflowId: string;
  /** 已存 definition（服务端那份）；缺省视作「无从判断」，不抽。 */
  definition?: WorkflowDefinition;
  /** 工作流顶层的出处（服务端权威字段）：只有对话固化来的才抽。 */
  source?: WorkflowSource | null;
  /** 抽到槽位后回调最新的工作流，供列表 / 编辑器跟上服务端的改动。 */
  onSuggested?: (workflow: UserWorkflow) => void;
}): SuggestedSlotsState {
  const existing = useMemo(
    () => (definition ? workflowSlots(definition) : []),
    [definition],
  );
  const wanted =
    open &&
    workflowId !== "" &&
    definition !== undefined &&
    existing.length === 0 &&
    isWorkflowFromTurn(source);

  const [fresh, setFresh] = useState<WorkflowSlot[] | null>(null);
  const [pending, setPending] = useState(false);
  // 回调只是「让父层跟上」，不该算进重抽条件（父层常传内联函数）。
  const notifyRef = useRef(onSuggested);
  notifyRef.current = onSuggested;
  // 本次开启已经发过请求的工作流：StrictMode 的双触发、父层吸收结果后的重渲染都不该再抽。
  const attemptedRef = useRef<string | null>(null);
  // 关掉 / 换工作流后落地的结果只更新父层，不再往这次对话框里塞。
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      attemptedRef.current = null;
      seqRef.current += 1;
      setFresh(null);
      setPending(false);
      return;
    }
    // 父层把抽到的槽位吸收进 definition 后 `wanted` 会翻假，此时什么都不做：
    // 一清 `fresh` 就把刚给用户的「这些是新抽的」提示抖没了。
    if (!wanted || attemptedRef.current === workflowId) return;
    attemptedRef.current = workflowId;
    if (NOTHING_EXTRACTED.has(workflowId)) return;
    const mine = ++seqRef.current;
    setPending(true);
    void (async () => {
      try {
        const next = await suggestWorkflowSlots(workflowId);
        const slots = workflowSlots(next.definition);
        if (slots.length === 0) {
          NOTHING_EXTRACTED.add(workflowId);
          return;
        }
        // 晚于对话框关闭也照样回调：抽到的槽位是这条工作流的事实，列表 / 编辑器
        // 该跟上（这次跑不带覆盖 = 原样重跑，不受影响）。
        notifyRef.current?.(next);
        if (mine === seqRef.current) setFresh(slots);
      } catch {
        // 抽不出来不是错误，请求挂了也不该拿错误挡住开跑：退回无参数形态。
      } finally {
        if (mine === seqRef.current) setPending(false);
      }
    })();
  }, [open, workflowId, wanted]);

  return { slots: fresh ?? existing, pending, fresh: fresh !== null };
}
