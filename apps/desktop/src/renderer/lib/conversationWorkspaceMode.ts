import type { FolderMeta } from "@/services/folders";
import type { Conversation } from "@/stores/conversation";

/** `localContainerRootId == null` → cloud; otherwise local. */
export function isConversationLocal(conv: {
  localContainerRootId?: string | null;
}): boolean {
  return conv.localContainerRootId != null;
}

/**
 * Derive a folder group's default workspace mode for the sidebar header and
 * row deduplication. Uses `folder.localDir` when set; otherwise majority vote
 * over member conversations' `localContainerRootId`; ties break on the most
 * recent conversation (callers should pass recency-sorted `convs`).
 */
export function deriveGroupWorkspaceIsLocal(
  folder: Pick<FolderMeta, "localDir">,
  convs: Pick<Conversation, "localContainerRootId">[],
): boolean {
  if (folder.localDir) return true;
  if (convs.length === 0) return false;

  let localCount = 0;
  for (const c of convs) {
    if (isConversationLocal(c)) localCount++;
  }
  const cloudCount = convs.length - localCount;
  if (localCount > cloudCount) return true;
  if (cloudCount > localCount) return false;
  const [first] = convs;
  return first ? isConversationLocal(first) : false;
}

/**
 * Whether a conversation row should show the cloud icon.
 * Bare rows: cloud only. Group rows: cloud exceptions when the group default
 * is local (desktop noise reduction — never show HardDrive on rows).
 */
export function shouldShowConversationCloudIcon(
  conv: Pick<Conversation, "localContainerRootId">,
  groupIsLocal?: boolean,
): boolean {
  const convIsLocal = isConversationLocal(conv);
  if (groupIsLocal === undefined) return !convIsLocal;
  if (convIsLocal === groupIsLocal) return false;
  return !convIsLocal;
}
