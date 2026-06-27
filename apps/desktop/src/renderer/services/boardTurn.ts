import type { BoardElement } from "@/services/boardOps";
import { ensureBoardConversation } from "@/services/boards";
import { streamConversation } from "@/services/streamConversation";

/**
 * Run one AI turn on a board's dedicated conversation (AI协作白板.md §六 M2 入口).
 *
 * The board counterpart of the chat composer's send: it (1) lazily mints + binds the
 * board's AI conversation (idempotent — the server returns the existing one after the
 * first call) so the turn is recognized as a 白板会话 and the CEO gets `board_ops`, then
 * (2) streams the turn on that conversation. Every SSE event is dispatched through the
 * shared pump, so a `board_op_required` lands on this board's registered applier (the
 * open canvas) and draws — that is the whole point of the turn.
 *
 * Unlike `sendQuickTurn` this targets the board's OWN conversation (not the active chat),
 * and deliberately doesn't seed the conversation store with an optimistic user bubble:
 * the canvas has no chat surface, the server persists the transcript authoritatively, and
 * the visible effect is the canvas mutating. Errors propagate so the canvas can show its
 * own (toast) feedback — a user abort surfaces as an `AbortError` for the caller to ignore.
 */
export async function sendBoardTurn(
  boardId: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const { conversation_id } = await ensureBoardConversation(boardId);
  await streamConversation({
    conversationId: conversation_id,
    content,
    signal,
  });
}

/**
 * Render a selection into a compact, model-readable list for the「整理选区」prompt.
 *
 * One line per selected element: its real `id` (so the AI can target it with `board_ops`
 * move / set_text / group), its shape, position, and any text. Elements not in the scene
 * (a stale selection id) are skipped. Pure — unit-tested without the editor.
 */
export function describeSelection(
  elements: readonly BoardElement[],
  selectedIds: readonly string[],
): string {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const lines: string[] = [];
  for (const id of selectedIds) {
    const el = byId.get(id);
    if (!el) continue;
    const shape = typeof el.type === "string" ? el.type : "element";
    const where =
      typeof el.x === "number" && typeof el.y === "number"
        ? ` @(${Math.round(el.x)},${Math.round(el.y)})`
        : "";
    const text =
      typeof el.text === "string" && el.text.trim()
        ? `：“${el.text.trim()}”`
        : "";
    lines.push(`- [${id}] ${shape}${where}${text}`);
  }
  return lines.join("\n");
}

/** Compose the「整理选区」turn prompt from a rendered selection (see {@link describeSelection}). */
export function organizeSelectionPrompt(selectionDescription: string): string {
  return [
    "我在白板上选中了以下元素，请你用 board_ops 帮我把它们整理得更清晰、更有条理",
    "（例如：对齐、重新排布、按主题分组、补充必要的连线或简短说明）。",
    "对已存在的元素请用它们的真实 id 操作；需要新增节点时给 ref 再连线。",
    "",
    "选中的元素：",
    selectionDescription,
  ].join("\n");
}
