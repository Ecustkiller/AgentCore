/**
 * Mobile-only wording for deleting a conversation.
 *
 * `DELETE /v1/conversations/{id}` is a soft delete (see deleteConversation).
 * Confirm may name「最近删除」— the same entry `listConversationTrash` reads.
 * Do not import the desktop copy.
 *
 * Forbidden in user-facing strings: 不可撤销 / 永久删除.
 */

/** Menu / action label for deleting a conversation. */
export const DELETE_CONVERSATION_LABEL = "删除对话";

/**
 * Confirm-step sentence. Soft-delete is recoverable from「最近删除」;
 * never claim the delete is permanent / irreversible.
 */
export function deleteConversationConfirmLabel(): string {
  return "确认删除（可在「最近删除」里恢复）";
}
