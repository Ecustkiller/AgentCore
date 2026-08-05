/**
 * 手机 composer 态敏主槽决策（对齐桌面 TurnComposer mid-flight + 行业空态麦）。
 * 纯函数便于单测；ChatPage 只消费结果。
 */
export function composerTrailingSlots(opts: {
  busy: boolean;
  hasDraft: boolean;
  voiceSupported: boolean;
  voiceActive: boolean;
}): {
  /** 主行右侧控件（顺序即渲染序）。 */
  row: Array<"steer-send" | "send" | "stop" | "voice">;
  /** 行外排队轻链（仅 busy + 有草稿）。 */
  showQueueHint: boolean;
} {
  const { busy, hasDraft, voiceSupported, voiceActive } = opts;

  if (busy) {
    return {
      row: hasDraft ? ["steer-send", "stop"] : ["stop"],
      showQueueHint: hasDraft,
    };
  }

  if (voiceSupported && (voiceActive || !hasDraft)) {
    return { row: ["voice"], showQueueHint: false };
  }

  return { row: ["send"], showQueueHint: false };
}
