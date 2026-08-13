/**
 * 「本轮内都允许」之后到底放行了多少次——纯计算面。
 *
 * 一次点击覆盖本回合内整整一类操作（含队员发起的），而被覆盖的调用**不会再弹卡**：
 * 服务端在 gate 里直接短路（`runtime/approvals.py` 的 `_granted`），线材上没有任何
 * 「这次因授权免问」的事件。所以这个数只能由呈现侧推：本回合观察到的调用，减去弹过卡的。
 *
 * 不认领因果：只数「授权之后、覆盖面内、从未弹过卡」的调用，文案也只说「没再问你」——
 * 会话级信任（`file_write=session`）/ 开工授权同样可能覆盖同一面，把它们说成「这次授权
 * 放行的」就是替用户编一个因果。锚点（授权那次调用本身）找不到时返回 0：宁可不说。
 */

import { FILE_OP_TOOLS } from "@/services/approvals";

/** 本回合观察到的一次工具调用（CEO 过程线 / 协作图 frame 都能降到这个形状）。 */
export interface ObservedToolCall {
  toolCallId: string;
  toolName: string;
}

/**
 * 一次授权实际覆盖的工具面；非授权决定（approve / deny / …）返回 null。
 *
 * `approve_always` = 卡上那一个工具；`approve_always_files` = 整个文件改动类
 * （对齐后端 `approval_class_tool_names()`，含 git 写入）。
 */
export function turnGrantScope(
  decision: string,
  toolName: string,
): ReadonlySet<string> | null {
  if (decision === "approve_always") {
    return toolName ? new Set([toolName]) : null;
  }
  if (decision === "approve_always_files") return FILE_OP_TOOLS;
  return null;
}

/**
 * 把「协作图 frame 里的调用」和「CEO 过程线里的调用」并成一条可比先后的序列。
 *
 * frame 流里既有 CEO 自己的调用也有队员的，本身就是全量按序——只要授权那次调用在里面，
 * 它就是唯一权威。它不在里面只有一种情形：授权发生在派团之前（那时还没有图，frame 被丢），
 * 此时队员的调用必然都在授权之后，接在 CEO 过程线尾部即为真序；重复 id 只保留过程线那次，
 * 免得同一次调用被数两遍。
 */
export function observedCallSpine({
  processCalls,
  frameCalls,
  grantToolCallId,
}: {
  processCalls: readonly ObservedToolCall[];
  frameCalls: readonly ObservedToolCall[];
  grantToolCallId: string;
}): ObservedToolCall[] {
  if (frameCalls.some((c) => c.toolCallId === grantToolCallId)) {
    return [...frameCalls];
  }
  const inProcess = new Set(processCalls.map((c) => c.toolCallId));
  return [
    ...processCalls,
    ...frameCalls.filter((c) => !inProcess.has(c.toolCallId)),
  ];
}

/** 授权之后、覆盖面内、始终没弹过卡的调用数。 */
export function countUnaskedSinceGrant({
  calls,
  grantToolCallId,
  scope,
  askedToolCallIds,
}: {
  /** 本回合的调用，按发生顺序。 */
  calls: readonly ObservedToolCall[];
  /** 授权那张卡对应的调用（时间锚点）。 */
  grantToolCallId: string;
  scope: ReadonlySet<string>;
  /** 弹过卡的调用（含被顺带放行的兄弟卡——那些用户看见了）。 */
  askedToolCallIds: ReadonlySet<string>;
}): number {
  const anchor = calls.findIndex((c) => c.toolCallId === grantToolCallId);
  if (anchor < 0) return 0;
  const counted = new Set<string>();
  for (let i = anchor + 1; i < calls.length; i++) {
    const { toolCallId, toolName } = calls[i];
    if (!toolCallId || counted.has(toolCallId)) continue;
    if (!scope.has(toolName)) continue;
    if (askedToolCallIds.has(toolCallId)) continue;
    counted.add(toolCallId);
  }
  return counted.size;
}
