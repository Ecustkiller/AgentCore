import { Button } from "@/components/ui";
import { useConversations } from "@/hooks/useConversations";
import { useLlmKey } from "@/hooks/useLlmKey";
import {
  STARTER_TASK_CHIPS,
  hasModelAccess,
  resolveDraftEmptyKind,
} from "@/lib/onboarding";
import { useComposerDraftStore } from "@/stores/composer";
import { useOnboardingUiStore } from "@/stores/onboardingUi";
import { BookOpen, KeyRound, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * 草稿页空态三态：未配 key / 首启任务 chips / 老用户单句。
 * 仅在 ChatView 无消息时渲染。
 */
export function DraftEmptyState({
  previewKind,
}: {
  /** Offline preview override. */
  previewKind?: ReturnType<typeof resolveDraftEmptyKind>;
}) {
  const { data: llm } = useLlmKey();
  const conversations = useConversations();
  const kind =
    previewKind ??
    resolveDraftEmptyKind({
      hasModelAccess: hasModelAccess(llm),
      conversationCount: conversations.length,
    });
  const openOnboarding = useOnboardingUiStore((s) => s.openOnboarding);
  const fill = useComposerDraftStore((s) => s.fill);

  if (kind === "needs_key") {
    return (
      <div
        className="mx-auto max-w-md px-6 text-center"
        data-empty-kind="needs_key"
      >
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound size={22} />
        </div>
        <p className="text-2xl font-medium text-foreground">先连接你的模型</p>
        <p className="mt-2 text-sm text-muted-foreground">
          用你自己的 API Key 驱动整支 AI 团队。未配置前无法发起对话。
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <Button size="md" onClick={() => openOnboarding()}>
            开始接入
          </Button>
          <Link
            to="/toolbox/manual"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <BookOpen size={12} />
            产品手册
          </Link>
        </div>
      </div>
    );
  }

  if (kind === "starter_chips") {
    return (
      <div
        className="mx-auto max-w-lg px-6 text-center"
        data-empty-kind="starter_chips"
      >
        <p className="text-2xl font-medium text-foreground">
          今天想解决什么问题？
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          试试这些会拉起多 Agent 协作的任务——点一下填入输入框，再按发送。
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {STARTER_TASK_CHIPS.map((text) => (
            <Button
              key={text}
              variant="neutral"
              icon={<Sparkles size={12} className="text-primary" />}
              className="h-auto max-w-full whitespace-normal border border-border bg-card px-3 py-2 text-left text-muted-foreground hover:border-primary/40 hover:text-foreground"
              onClick={() => fill(text)}
            >
              {text}
            </Button>
          ))}
        </div>
        <Link
          to="/toolbox/manual"
          className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <BookOpen size={12} />
          产品手册
        </Link>
      </div>
    );
  }

  return (
    <div className="text-center" data-empty-kind="returning">
      <p className="text-2xl font-medium text-foreground">
        今天想解决什么问题？
      </p>
    </div>
  );
}
