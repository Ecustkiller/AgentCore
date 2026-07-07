import {
  injectSimulationEvent,
  type InjectEventType,
} from "@/services/simulation/api";
import { notifyError, notifySuccess } from "@/lib/toast";
import { useSimulationUiStore } from "@/simulation/store/simulationStore";
import {
  CloudRain,
  Loader2,
  Megaphone,
  PartyPopper,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";

type PresetEvent = {
  type: InjectEventType;
  emoji: string;
  label: string;
  description: string;
  icon: typeof TrendingUp;
  tone: string;
};

const PRESET_EVENTS: PresetEvent[] = [
  {
    type: "price_surge",
    emoji: "📈",
    label: "市场物价上涨",
    description: "提高市场交易价格倍率",
    icon: TrendingUp,
    tone: "border-success/30 bg-success/5 hover:bg-success/10",
  },
  {
    type: "storm",
    emoji: "🌧️",
    label: "暴风雨来袭",
    description: "所有居民倾向回家",
    icon: CloudRain,
    tone: "border-primary/30 bg-primary/5 hover:bg-primary/10",
  },
  {
    type: "festival",
    emoji: "🎉",
    label: "节日庆典",
    description: "广场吸引力增大，情绪提升",
    icon: PartyPopper,
    tone: "border-success/30 bg-success/5 hover:bg-success/10",
  },
  {
    type: "announcement",
    emoji: "📢",
    label: "镇长公告",
    description: "触发镇政厅投票议题",
    icon: Megaphone,
    tone: "border-destructive/30 bg-destructive/5 hover:bg-destructive/10",
  },
];

export function GodModePanel() {
  const run = useSimulationUiStore((s) => s.run);
  const [injecting, setInjecting] = useState<InjectEventType | null>(null);
  const [customType, setCustomType] = useState("custom");
  const [customPayload, setCustomPayload] = useState("{}");
  const [customSending, setCustomSending] = useState(false);

  const runId = run?.id;
  const disabled = !runId;

  async function handlePreset(type: InjectEventType) {
    if (!runId || injecting) return;
    setInjecting(type);
    try {
      const res = await injectSimulationEvent(runId, type);
      notifySuccess(`已注入：${res.title}`, {
        description: `将在 Tick ${res.queued_for_tick} 生效`,
      });
    } catch (err) {
      notifyError(err, "事件注入失败");
    } finally {
      setInjecting(null);
    }
  }

  async function handleCustomSend() {
    if (!runId || customSending) return;
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(customPayload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        notifyError("payload 必须是 JSON 对象");
        return;
      }
    } catch {
      notifyError("payload JSON 格式无效");
      return;
    }

    const eventType = customType.trim() as InjectEventType;
    if (!eventType) {
      notifyError("请填写 event_type");
      return;
    }

    setCustomSending(true);
    try {
      const res = await injectSimulationEvent(runId, eventType, payload);
      notifySuccess(`已注入：${res.title}`, {
        description: `将在 Tick ${res.queued_for_tick} 生效`,
      });
    } catch (err) {
      notifyError(err, "自定义事件注入失败");
    } finally {
      setCustomSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          向模拟世界注入事件，影响下一 tick 的居民行为与环境。
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {disabled ? (
          <p className="text-sm text-muted-foreground">
            请先创建或加载一个模拟 Run。
          </p>
        ) : null}

        <section className={disabled ? "pointer-events-none opacity-50" : ""}>
          <h3 className="text-xs font-medium text-muted-foreground">预设事件</h3>
          <ul className="mt-2 space-y-2">
            {PRESET_EVENTS.map((preset) => {
              const Icon = preset.icon;
              const loading = injecting === preset.type;
              return (
                <li key={preset.type}>
                  <button
                    type="button"
                    disabled={!!injecting}
                    className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed ${preset.tone}`}
                    onClick={() => void handlePreset(preset.type)}
                  >
                    <span className="text-xl leading-none" aria-hidden>
                      {preset.emoji}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {preset.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {preset.description}
                      </span>
                    </span>
                    {loading ? (
                      <Loader2
                        className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section
          className={`mt-6 ${disabled ? "pointer-events-none opacity-50" : ""}`}
        >
          <h3 className="text-xs font-medium text-muted-foreground">自定义事件</h3>
          <div className="mt-2 space-y-3 rounded-xl border border-border bg-background p-3">
            <label className="block">
              <span className="text-xs text-muted-foreground">event_type</span>
              <input
                type="text"
                value={customType}
                onChange={(e) => setCustomType(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground"
                placeholder="custom"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted-foreground">payload (JSON)</span>
              <textarea
                value={customPayload}
                onChange={(e) => setCustomPayload(e.target.value)}
                rows={5}
                className="mt-1 w-full resize-y rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              disabled={customSending || !!injecting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleCustomSend()}
            >
              {customSending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              发送自定义事件
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
