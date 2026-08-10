import { Card } from "@/components/ui";
import { Switch } from "@/components/ui/Switch";
import { hasLocalEngine } from "@/lib/capabilities";
import { type Theme, resolveDark } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { clearSidecarHealth } from "@/services/sidecarHealth";
import { useUIStore } from "@/stores/ui";
import { Check, type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { SettingsHeader } from "./SettingsHeader";

interface ThemeOption {
  value: Theme;
  label: string;
  description: string;
  icon: LucideIcon;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    value: "light",
    label: "浅色",
    description: "始终使用浅色界面。",
    icon: Sun,
  },
  {
    value: "dark",
    label: "深色",
    description: "始终使用深色界面。",
    icon: Moon,
  },
  {
    value: "system",
    label: "跟随系统",
    description: "随操作系统的外观自动切换。",
    icon: Monitor,
  },
];

/**
 * 外观设置（/more/appearance）— 主题选择；桌面有 sidecar 能力时附带「允许本机执行」
 *（诊断 / 强制关语义，非「默认关→整段过桥」）。
 *
 * 写入共享的 `useUIStore.theme`（持久化到 localStorage），应用由 `lib/theme.ts`
 * 统一收口（AppShell 的 `useApplyTheme` 切 root `.dark` 类、`系统`档随 OS 跟随），
 * 与命令面板的「切换主题」命令同一条链路——这里只是它的可视化入口。
 */
export function AppearanceSettings() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  return (
    <div>
      <SettingsHeader
        title="外观"
        description="选择界面主题。也可在命令面板（Ctrl/Cmd+K）中快速切换。"
      />

      <section className="mt-6">
        <h2 className="text-base font-medium">主题</h2>
        <div className="mt-4 space-y-2">
          {THEME_OPTIONS.map((option) => (
            <ThemeRow
              key={option.value}
              option={option}
              selected={theme === option.value}
              onSelect={() => setTheme(option.value)}
            />
          ))}
        </div>
      </section>

      {hasLocalEngine() && <LocalEngineToggle />}
    </div>
  );
}

/** One selectable theme card: icon badge + label/description + a check when
 * active. The 跟随系统 row also shows what it currently resolves to. */
function ThemeRow({
  option,
  selected,
  onSelect,
}: {
  option: ThemeOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = option.icon;
  const resolvedHint =
    option.value === "system"
      ? `当前解析为「${resolveDark("system") ? "深色" : "浅色"}」`
      : null;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left",
        selected
          ? "border-primary"
          : "transition-colors hover:border-primary/40 hover:bg-accent/40",
      )}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
          selected
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        }`}
      >
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{option.label}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {option.description}
          {resolvedHint ? ` · ${resolvedHint}` : ""}
        </span>
      </span>
      {selected && <Check size={16} className="shrink-0 text-primary" />}
    </button>
  );
}

/**
 * 诊断 / 强制关：本机传统项目新开回合默认同侧 sidecar；关 = 显式强制走云。
 * 展示用 `preference !== "off"`（unset 与 on 都算允许），勿绑 `sidecarEnabled`
 *（unset→默认 false，会显示关却仍默认同侧）。
 */
function LocalEngineToggle() {
  const preference = useUIStore((s) => s.sidecarPreference);
  const setEnabled = useUIStore((s) => s.setSidecarEnabled);
  const allowed = preference !== "off";
  const onToggle = (v: boolean): void => {
    setEnabled(v);
    if (v) clearSidecarHealth();
  };
  return (
    <Card className="mt-6 flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">允许本机执行</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          本机传统项目默认在本机跑回合（引擎与盘同侧）；启动失败会自动改走云端过桥。关闭后强制全部走云（诊断用）。云端项目不受影响，始终走云。这不是离线模式：AI
          推理仍在云端，断网时只能浏览缓存与本机文件（只读），不能发送。
        </p>
      </div>
      <Switch
        checked={allowed}
        onCheckedChange={onToggle}
        label="允许本机执行"
      />
    </Card>
  );
}
