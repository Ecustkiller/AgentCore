import { create } from "zustand";
import { createMessageWindowActions } from "./messageWindowActions";
import { createSessionSliceActions } from "./sessionSliceActions";
import type { ConversationState } from "./state";
import { createStreamProjectionActions } from "./streamProjectionActions";
import { createTurnLifecycleActions } from "./turnLifecycleActions";

export type { ConversationState } from "./state";

export const useConversationStore = create<ConversationState>((set, get) => ({
  currentConversationId: null,
  byId: {},
  sliceLruOrder: [],
  pendingFocus: null,

  ...createMessageWindowActions(set, get),
  ...createStreamProjectionActions(set, get),
  ...createTurnLifecycleActions(set, get),
  ...createSessionSliceActions(set, get),
}));
