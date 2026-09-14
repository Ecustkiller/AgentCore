import { useSidePanelStore } from "./store";

const UNSAVED_CLOSE_COPY = "有未保存的改动，确定关闭？";

/** Explicit-save file tabs (FilePreviewView): confirm before × / float close. */
export function confirmFileTabDiscard(tabId: string): boolean {
  const chrome = useSidePanelStore.getState().fileTabChrome[tabId];
  if (!chrome?.confirmDiscard) return true;
  return window.confirm(UNSAVED_CLOSE_COPY);
}

export { UNSAVED_CLOSE_COPY };
