import {
  ModelKeyForm,
  modelConfigApiErrorMessage,
} from "@/components/llm/ModelKeyForm";
import { Button } from "@/components/ui";
import { notifyOnboardingSkipChanged } from "@/hooks/useOnboarding";
import { markOnboardingSkipped } from "@/lib/onboarding";
import { llmKeyKeys } from "@/lib/queryKeys";
import { type LlmKeyStatus, testLlmKey } from "@/services/llmKey";
import { useOnboardingUiStore } from "@/stores/onboardingUi";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Crown,
  GitBranch,
  Network,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { useState } from "react";

type Step = "value" | "connect" | "probing";

const CAPABILITY_SLIDES = [
  {
    icon: Users,
    title: "一支 AI 团队，不是单个助手",
    body: "你只对接一位 CEO。复杂任务它自己拉人、分工、互审，最后把结果交到你手里。",
  },
  {
    icon: Network,
    title: "协作图实时可见",
    body: "每个人在做什么一目了然。点节点就能看每个 Agent 的实时工作与产出。",
  },
  {
    icon: ShieldCheck,
    title: "关键节点由你拍板",
    body: "检查点、审批、计划复核——团队会停下来问你，而不是自作主张。",
  },
  {
    icon: GitBranch,
    title: "说目标，别说步骤",
    body: "怎么拆、谁来做、先后顺序交给 CEO。你定方向、审产出、拍板决策。",
  },
] as const;

/**
 * 一次性首启全页流程：价值一屏 → 模型接入（复用 ModelKeyForm）→ 测连通时展示能力介绍。
 */
export function OnboardingFlow({
  onDismiss,
  previewStep,
  embedded = false,
}: {
  onDismiss?: () => void;
  /** Offline preview: pin a step without live data. */
  previewStep?: Step;
  /** Use absolute fill of parent (preview pane) instead of viewport-fixed. */
  embedded?: boolean;
}) {
  const [step, setStep] = useState<Step>(previewStep ?? "value");
  const [probeError, setProbeError] = useState<string | null>(null);
  const [slide, setSlide] = useState(0);
  const queryClient = useQueryClient();
  const closeForced = useOnboardingUiStore((s) => s.closeOnboarding);

  const finish = () => {
    closeForced();
    onDismiss?.();
  };

  const skip = () => {
    markOnboardingSkipped();
    notifyOnboardingSkipChanged();
    finish();
  };

  const afterSaved = async (status: LlmKeyStatus) => {
    queryClient.setQueryData(llmKeyKeys.status, status);
    setProbeError(null);
    setStep("probing");
    setSlide(0);
    // Rotate capability slides while probing — product story, not a bare spinner.
    const timer = window.setInterval(() => {
      setSlide((s) => (s + 1) % CAPABILITY_SLIDES.length);
    }, 2800);
    try {
      const probed = await testLlmKey();
      queryClient.setQueryData(llmKeyKeys.status, probed);
      window.clearInterval(timer);
      finish();
    } catch (e) {
      window.clearInterval(timer);
      setProbeError(
        modelConfigApiErrorMessage(
          e,
          "连接测试未通过，请检查 Key 与 Base URL 后重试",
        ),
      );
      setStep("connect");
    }
  };

  const active = previewStep ?? step;

  return (
    // biome-ignore lint/a11y/useSemanticElements: 全屏接管层非原生 <dialog>（无 showModal 生命周期），保留 ARIA dialog 语义。
    <div
      role="dialog"
      aria-modal={!embedded}
      aria-label="欢迎使用 AgentCore"
      data-onboarding-step={active}
      className={`${
        embedded ? "relative h-full w-full" : "fixed inset-0"
      } z-50 flex flex-col bg-background`}
    >
      {/* Atmosphere — soft brand wash, no new deps */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -left-1/4 top-0 h-[60%] w-[70%] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -right-1/4 bottom-0 h-[50%] w-[60%] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <header className="relative z-10 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
            A
          </span>
          <span className="text-sm font-semibold tracking-tight text-foreground">
            AgentCore
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={skip}>
          跳过
        </Button>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-6 pb-16">
        {active === "value" && (
          <ValueScreen onContinue={() => setStep("connect")} />
        )}
        {active === "connect" && (
          <ConnectScreen
            probeError={probeError}
            onSaved={(s) => void afterSaved(s)}
          />
        )}
        {active === "probing" && <ProbingScreen slideIndex={slide} />}
      </main>
    </div>
  );
}

function ValueScreen({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="mx-auto w-full max-w-xl text-center">
      <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Crown size={28} />
      </div>
      <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        指挥一支 AI 团队
      </p>
      <h1 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        别的 AI 是一个助手
        <br />
        这里是一整支团队
      </h1>
      <p className="mx-auto mt-4 max-w-md text-pretty text-base text-muted-foreground">
        你说目标，它们自己分工、互审、交付。你是领导者——定方向、审产出、拍板。
        协作，是更高级的智能。
      </p>
      <div className="mx-auto mt-8 grid max-w-lg gap-3 text-left sm:grid-cols-3">
        {[
          { t: "ChatGPT", d: "你是提示者" },
          { t: "Cursor", d: "你是指令者" },
          { t: "AgentCore", d: "你是领导者", hi: true },
        ].map((c) => (
          <div
            key={c.t}
            className={`rounded-xl border px-3 py-3 ${
              c.hi
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-card/60"
            }`}
          >
            <p className="text-xs text-muted-foreground">{c.t}</p>
            <p
              className={`mt-1 text-sm font-medium ${
                c.hi ? "text-primary" : "text-foreground"
              }`}
            >
              {c.d}
            </p>
          </div>
        ))}
      </div>
      <Button size="md" className="mt-10" onClick={onContinue}>
        连接你的模型
        <ArrowRight size={16} />
      </Button>
    </div>
  );
}

function ConnectScreen({
  onSaved,
  probeError,
}: {
  onSaved: (s: LlmKeyStatus) => void;
  probeError: string | null;
}) {
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Sparkles size={22} />
        </div>
        <h2 className="text-2xl font-semibold text-foreground">连接你的模型</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          选择厂商、填入 API Key，我们会帮你测通后再开始第一场协作。
        </p>
      </div>
      {probeError && (
        <p className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {probeError}
        </p>
      )}
      <ModelKeyForm
        configured={false}
        initialBaseUrl=""
        initialModel=""
        submitLabel="连接并测试"
        savingLabel="保存中…"
        hideTestHint
        onSaved={onSaved}
      />
    </div>
  );
}

function ProbingScreen({ slideIndex }: { slideIndex: number }) {
  const slide =
    CAPABILITY_SLIDES[slideIndex % CAPABILITY_SLIDES.length] ??
    CAPABILITY_SLIDES[0];
  const Icon = slide.icon;
  return (
    <div className="mx-auto w-full max-w-md text-center">
      <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon size={28} className="animate-pulse" />
      </div>
      <p className="text-xs font-medium text-muted-foreground">正在测试连接…</p>
      <h2 className="mt-3 text-xl font-semibold text-foreground">
        {slide.title}
      </h2>
      <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground">
        {slide.body}
      </p>
      <div className="mt-8 flex justify-center gap-1.5">
        {CAPABILITY_SLIDES.map((s, i) => (
          <span
            key={s.title}
            className={`h-1.5 w-1.5 rounded-full ${
              i === slideIndex % CAPABILITY_SLIDES.length
                ? "bg-primary"
                : "bg-muted-foreground/30"
            }`}
          />
        ))}
      </div>
      <p className="mt-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 size={12} className="text-success" />
        测通后即可开始指挥团队
      </p>
    </div>
  );
}
