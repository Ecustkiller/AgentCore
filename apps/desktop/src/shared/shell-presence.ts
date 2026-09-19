/**
 * 壳在场：本应用是否被当成正在用的产品窗。
 *
 * 主窗可见且未最小化（真窗随藏），并且主窗或任一真窗有焦点。
 * 「主窗有焦点」单独不够——人可以在看浮窗。
 */

export interface ShellPresenceSnapshot {
  present: boolean;
  /** 当前打开的真窗所跟的对话。场面闸用，不是运行时会话指针。 */
  floatConversationIds: string[];
}

export interface ShellPresenceWindowBits {
  destroyed: boolean;
  minimized: boolean;
  visible: boolean;
  focused: boolean;
}

export interface ShellPresenceFloatBits {
  destroyed: boolean;
  focused: boolean;
  conversationId: string;
}

export function computeShellPresence(input: {
  main: ShellPresenceWindowBits | null;
  floats: readonly ShellPresenceFloatBits[];
}): ShellPresenceSnapshot {
  const liveFloats = input.floats.filter((f) => !f.destroyed);
  const floatConversationIds = [
    ...new Set(
      liveFloats
        .map((f) => f.conversationId.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  const main = input.main;
  const mainUsable = Boolean(
    main && !main.destroyed && !main.minimized && main.visible,
  );
  const appForeground =
    mainUsable && Boolean(main?.focused || liveFloats.some((f) => f.focused));
  return { present: appForeground, floatConversationIds };
}
