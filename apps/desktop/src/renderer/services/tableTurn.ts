import { streamConversation } from "@/services/streamConversation";
import { ensureTableConversation } from "@/services/tables";

export interface TableTurnOptions {
  signal?: AbortSignal;
  /** Row ids frozen at send time. Mutating the array afterwards must not change this turn. */
  tableSelection?: readonly string[];
  onConversation?: (conversationId: string) => void;
}

/**
 * One AI turn on a table's dedicated conversation (ensure + stream).
 * `table_selection` is the row-id snapshot at send —
 * deselecting afterwards does not change this turn.
 */
export async function sendTableTurn(
  tableId: string,
  content: string,
  options: TableTurnOptions = {},
): Promise<void> {
  const tableSelection = [...(options.tableSelection ?? [])];
  const { conversationId } = await ensureTableConversation(tableId);
  options.onConversation?.(conversationId);
  await streamConversation({
    conversationId,
    content,
    delivery: "steer",
    signal: options.signal,
    tableSelection,
  });
}
