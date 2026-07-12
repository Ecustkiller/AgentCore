import { MANUAL_HELP, ManualHelpLink } from "@/components/ManualHelpLink";
import { notifyError, notifySuccess } from "@/lib/toast";
import { api } from "@/services/api";
import { setCachedAutonomyPolicy } from "@/services/autonomyPolicy";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsHeader } from "./SettingsHeader";

type AutonomyPolicy = "always_ask" | "first_grant" | "full_auto";

interface AutonomyOption {
  value: AutonomyPolicy;
  label: string;
  description: string;
}

const OPTIONS: AutonomyOption[] = [
  {
    value: "always_ask",
    label: "每次询问",
    description: "每个可授权工具调用都弹出审批，不在开工卡一次放行。",
  },
  {
    value: "first_grant",
    label: "开工一次授权（推荐）",
    description: "开工卡一次授权本委派所需能力，之后同委派内免逐次弹窗。",
  },
  {
    value: "full_auto",
    label: "全自动授权",
    description: "完全放权：不弹开工卡，能力与计划确认一并跳过。",
  },
];

/**
 * 自主度设置（/more/autonomy）— AutonomyPolicy 三档（安全权限与治理 §三）。
 * full_auto 放行开工卡计划半边 + 能力半边；first_grant / always_ask 能力语义不变。
 */
export function AutonomySettings() {
  const [policy, setPolicy] = useState<AutonomyPolicy | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<{ policy: AutonomyPolicy }>("/v1/users/me/autonomy")
      .then((d) => {
        if (!alive) return;
        setPolicy(d.policy);
        setCachedAutonomyPolicy(d.policy);
      })
      .catch((e) => {
        if (!alive) return;
        notifyError(e, "加载自主度设置失败");
        setPolicy("first_grant");
      });
    return () => {
      alive = false;
    };
  }, []);

  const onSelect = async (next: AutonomyPolicy) => {
    if (next === policy || pending) return;
    setPending(true);
    try {
      const d = await api.put<{ policy: AutonomyPolicy }>(
        "/v1/users/me/autonomy",
        { policy: next },
      );
      setPolicy(d.policy);
      // 同步进本地缓存：下一个 sidecar 本地回合立即用上新档位（无需重启应用）。
      setCachedAutonomyPolicy(d.policy);
      notifySuccess("已更新自主度");
    } catch (e) {
      notifyError(e, "设置失败");
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <SettingsHeader
        title="自主度"
        description="控制团队开工时能力授权的节奏。只影响写文件 / 跑代码等可授权工具，不影响计划确认与检查点。"
        action={<ManualHelpLink to={MANUAL_HELP.autonomy} />}
      />

      <section className="mt-6 space-y-2">
        {policy === null ? (
          <Loader2
            size={16}
            className="animate-spin text-muted-foreground/50"
          />
        ) : (
          OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={pending}
              onClick={() => void onSelect(option.value)}
              className={
                option.value === policy
                  ? "flex w-full items-start gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 text-left"
                  : "flex w-full items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left hover:bg-accent/40"
              }
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {option.label}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          ))
        )}
      </section>
    </div>
  );
}
