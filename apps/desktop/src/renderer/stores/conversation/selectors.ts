import type { ErrorAction } from "@/lib/errors";
import { activeRuntime, runtimeOf } from "./runtime";
import { useConversationStore } from "./store";
import type { ConversationRuntime, Message } from "./types";

export const useActiveMessages = (): Message[] =>
  useConversationStore((s) => activeRuntime(s).messages);

export const useActiveGenerating = (): boolean =>
  useConversationStore((s) => activeRuntime(s).isGenerating);

export const useConversationGenerating = (conversationId: string): boolean =>
  useConversationStore((s) => runtimeOf(s, conversationId).isGenerating);

export const useActiveError = (): string | null =>
  useConversationStore((s) => activeRuntime(s).error);

export const useActiveRetry = (): (() => void) | null =>
  useConversationStore((s) => activeRuntime(s).retry);

export const useActiveErrorAction = (): ErrorAction | null =>
  useConversationStore((s) => activeRuntime(s).errorAction);

export const useActiveMessageFocus = (): { id: string; nonce: number } | null =>
  useConversationStore((s) => activeRuntime(s).messageFocus);

export const useActiveHasMoreBefore = (): boolean =>
  useConversationStore((s) => activeRuntime(s).hasMoreBefore);

export const useActiveHasMoreAfter = (): boolean =>
  useConversationStore((s) => activeRuntime(s).hasMoreAfter);

export const useActiveLoadingOlder = (): boolean =>
  useConversationStore((s) => activeRuntime(s).loadingOlder);

export const useActiveLoadingNewer = (): boolean =>
  useConversationStore((s) => activeRuntime(s).loadingNewer);

export const getActiveRuntime = (): ConversationRuntime =>
  activeRuntime(useConversationStore.getState());

export const getRuntime = (
  conversationId?: string | null,
): ConversationRuntime =>
  runtimeOf(useConversationStore.getState(), conversationId);
