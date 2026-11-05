import { useModels } from "@/hooks/useModels";
import {
  COMPOSER_VISION_HINT,
  draftHasImageAttachment,
  shouldShowComposerVisionHint,
  useComposerActiveProfile,
  useComposerModelPickerOpenStore,
} from "@/lib/composerModelProfile";
import { draftKeyFor, useComposerDraftStore } from "@/stores/composer";
import { useConversationStore } from "@/stores/conversation";
import { ImageOff } from "lucide-react";

const EMPTY_ATTACHMENTS: { name: string }[] = [];

/**
 * Draft has an image and the current combo cannot see it (no catalog vision on
 * main, no vision slot). Muted pre-send line; does not block send.
 */
export function ComposerVisionHint() {
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const draftKey = draftKeyFor(conversationId);
  const attachments = useComposerDraftStore(
    (s) => s.drafts[draftKey]?.attachments ?? EMPTY_ATTACHMENTS,
  );
  const { data: catalog } = useModels();
  const profile = useComposerActiveProfile();
  const requestModelPicker = useComposerModelPickerOpenStore(
    (s) => s.requestOpen,
  );
  if (
    !shouldShowComposerVisionHint({
      hasImage: draftHasImageAttachment(attachments),
      profile,
      catalogModels: catalog?.models ?? [],
    })
  ) {
    return null;
  }
  return (
    <output
      aria-live="polite"
      data-testid="composer-vision-hint"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-2 text-xs text-muted-foreground"
    >
      <ImageOff size={13} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{COMPOSER_VISION_HINT}</span>
      <button
        type="button"
        onClick={requestModelPicker}
        className="shrink-0 font-medium text-primary hover:underline"
      >
        切换看图模型
      </button>
    </output>
  );
}
