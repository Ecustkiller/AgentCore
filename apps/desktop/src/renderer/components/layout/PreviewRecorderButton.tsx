import { Button } from "@/components/ui";
import { notifyError, notifyInfo, notifyWarning } from "@/lib/toast";
import {
  getRecorderState,
  startRecording,
  stopRecording,
  useRecorderState,
} from "@/preview/recorder";
import { saveRecording } from "@/preview/recordings";
import {
  getRuntime,
  useConversationGenerating,
  useConversationStore,
} from "@/stores/conversation";
import { Circle, Square } from "lucide-react";
import { useEffect, useRef } from "react";

/** Compact `rec-YYYYMMDD-HHMMSS` name — URL-safe for `#/preview?s=…`. */
function stampName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `rec-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Stop recording and persist the buffered turn as a local preview recording.
 * Shared by the manual 停止 button and the auto-stop watcher; reads everything
 * fresh from the stores (no React closure) so either caller is correct. The
 * armed id is read before {@link stopRecording} disarms it, so the description
 * can be sourced from that conversation's last user message.
 */
function finalizeRecording(): void {
  const armed = getRecorderState().conversationId;
  const events = stopRecording();
  if (events.length === 0) {
    notifyWarning("未录到事件", {
      description: "录制期间没有 AI 事件，未保存。先开始录制再发消息。",
    });
    return;
  }
  const now = new Date();
  const convMessages = armed ? getRuntime(armed).messages : [];
  const lastUser = [...convMessages].reverse().find((m) => m.role === "user");
  const description = lastUser?.content?.trim().slice(0, 60) || "录制的回合";
  const name = stampName(now);
  try {
    saveRecording({ name, description, events, recordedAt: now.toISOString() });
    notifyInfo("已录制到预览", {
      description: `${name} · ${events.length} 事件`,
      action: {
        label: "去预览",
        onClick: () => {
          window.location.hash = `#/preview?s=${name}`;
        },
      },
    });
  } catch {
    notifyError(
      "录制保存失败：localStorage 可能已满，请先在预览里删除旧录制。",
    );
  }
}

/**
 * DEV-only record toggle (lives in the TitleBar next to the DEV badge). Arms the
 * SSE recorder for the current conversation; the next real turn's events are
 * buffered and saved as a local preview recording that shows up in `#/preview`
 * immediately. Stop is automatic — once the armed turn finishes it saves itself —
 * with a manual 停止 as the escape hatch. Captures real backend output so a
 * brand-new AI state can be eyeballed offline without re-running the turn.
 * Stripped from production (the caller gates on `import.meta.env.DEV`).
 */
export function PreviewRecorderButton() {
  const { recording, count, conversationId: armedConvId } = useRecorderState();
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const generating = useConversationGenerating(armedConvId ?? "");
  const sawGeneratingRef = useRef(false);

  // Auto-stop: once the armed turn actually started (isGenerating) and then
  // finished (back to false), save automatically — no manual 停止 click. Keys off
  // the app's own turn-lifecycle flag, so it ends correctly for single- and
  // multi-agent turns, errors, and aborts without enumerating terminal events.
  useEffect(() => {
    if (!recording) {
      sawGeneratingRef.current = false;
      return;
    }
    if (generating) {
      sawGeneratingRef.current = true;
    } else if (sawGeneratingRef.current) {
      sawGeneratingRef.current = false;
      finalizeRecording();
    }
  }, [recording, generating]);

  // Only real turns are recordable — never a `#/preview` replay (its synthetic
  // `preview-*` slice would otherwise re-record an existing fixture).
  const recordable = !!conversationId && !conversationId.startsWith("preview-");

  // Hidden until there's a real conversation to record — but once recording,
  // always shown so the turn can be stopped even after switching away.
  if (!recording && !recordable) return null;

  const start = () => {
    if (recordable && conversationId) startRecording(conversationId);
  };

  return recording ? (
    <Button
      variant="neutral"
      onClick={finalizeRecording}
      icon={
        <Square size={11} fill="currentColor" className="text-destructive" />
      }
      className="mr-2 h-7 gap-1.5 border border-destructive/40 px-2.5 text-sm text-destructive [-webkit-app-region:no-drag]"
    >
      停止 · {count}
    </Button>
  ) : (
    <Button
      variant="neutral"
      onClick={start}
      icon={
        <Circle size={11} fill="currentColor" className="text-destructive" />
      }
      className="mr-2 h-7 gap-1.5 border border-sidebar-border px-2.5 text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground [-webkit-app-region:no-drag]"
    >
      录制
    </Button>
  );
}
