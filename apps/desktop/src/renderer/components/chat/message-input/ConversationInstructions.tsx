import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  patchConversationCache,
  useConversations,
} from "@/hooks/useConversations";
import { notifyError } from "@/lib/toast";
import { setConversationInstructions } from "@/services/conversations";
import { ScrollText } from "lucide-react";
import { useEffect, useState } from "react";

/** Backend cap (UpdateConversationRequest.instructions max_length). Kept in sync so the
 * counter warns before the server would 422. */
const MAX_CHARS = 4000;

/**
 * 对话级自定义指令 (per-conversation custom instructions) — a composer-toolbar button that
 * opens an editor for a directive scoped to THIS conversation (对标 ChatGPT custom
 * instructions · Claude project instructions). The backend injects it into the
 * conversation's system prompt (above soft long-term memory), so every subsequent turn —
 * and its delegated team — follows it.
 *
 * Scope note: only meaningful for an existing conversation (the row must exist to persist
 * onto), so the host renders it once a `conversationId` exists. The current text is read
 * from the conversation cache; a save is optimistic (the「已设」dot flips at once, reverting
 * on a failed persist), mirroring the other per-conversation composer controls.
 */
export function ConversationInstructions({
  conversationId,
  disabled,
}: {
  conversationId: string;
  disabled?: boolean;
}) {
  const conversation = useConversations().find((c) => c.id === conversationId);
  const current = conversation?.instructions ?? "";
  const isSet = current.trim().length > 0;

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);

  // Re-seed the draft from the persisted value whenever the editor (re)opens, so a
  // cancelled edit never leaks into the next open and an external change is picked up.
  useEffect(() => {
    if (open) setValue(current);
  }, [open, current]);

  const dirty = value.trim() !== current.trim();
  const tooLong = value.length > MAX_CHARS;

  const save = async () => {
    const next = value.trim();
    const prev = current;
    if (next === prev.trim()) {
      setOpen(false);
      return;
    }
    setSaving(true);
    patchConversationCache(conversationId, { instructions: next || null });
    try {
      await setConversationInstructions(conversationId, next || null);
      setOpen(false);
    } catch (err) {
      patchConversationCache(conversationId, { instructions: prev || null });
      notifyError(err, "保存自定义指令失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SimpleTooltip
        label={
          isSet
            ? "自定义指令：本对话已设定（点击编辑）"
            : "自定义指令：为本对话设定专属指令"
        }
      >
        <button
          type="button"
          disabled={disabled}
          aria-label="本对话的自定义指令"
          onClick={() => setOpen(true)}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          <ScrollText size={14} className="shrink-0" />
          <span>指令</span>
          {isSet && (
            <span
              aria-hidden
              className="size-1.5 rounded-full bg-primary"
              title="已设定"
            />
          )}
        </button>
      </SimpleTooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>本对话的自定义指令</DialogTitle>
            <DialogDescription>
              仅作用于当前这一条对话，注入到系统提示中——之后的每一回合（含委派的子团队）都会遵循。
              适合设定角色、语气、输出格式或专属背景，例如「始终用中文、给出可执行清单」。
            </DialogDescription>
          </DialogHeader>
          <div className="px-5">
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={7}
              placeholder="例如：你是我的资深法律顾问，回答先给结论、再列依据，全程用中文。"
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                留空即清除本对话的自定义指令。
              </span>
              <span
                className={
                  tooLong ? "text-destructive" : "text-muted-foreground/70"
                }
              >
                {value.length} / {MAX_CHARS}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="neutral"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={saving || tooLong || !dirty}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
