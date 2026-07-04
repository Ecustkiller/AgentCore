import { TurnComposer } from "./message-input/TurnComposer";

/**
 * The chat view's composer: the unified {@link TurnComposer} in its chat chrome
 * (bottom padding, default placeholder, 后台云端 offered). The canvas 命令栏
 * ({@link import("../graph/CanvasCommandBar").CanvasCommandBar}) is the SAME core in
 * canvas chrome — one composer, two skins, single draft per conversation.
 */
export function MessageInput() {
  return (
    <div className="px-4 pb-4 pt-2">
      <TurnComposer />
    </div>
  );
}
